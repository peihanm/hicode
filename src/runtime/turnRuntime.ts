import {contentText, type MessageContent} from "../images/content.js";
import type {AgentEvent, AgentResult} from "../agent/types.js";
import {
    EMPTY_AGENT_INPUT_CHANNEL,
    type AgentInputChannel,
    type AgentRunOptions,
} from "../agent/index.js";
import {formatHookContext, type HookBatchResult, type HookInput} from "../hooks/index.js";
import type {PermissionMode} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import {
    type SaveSessionSnapshotInput,
    type PersistedUIEvent,
} from "../session/index.js";
import type {Todo} from "../todos.js";
import type {ToolContextHost} from "./toolContext.js";
import type {RootRuntimeResources} from "./resources.js";
import type {RootSessionRuntime} from "./sessionRuntime.js";
import {normalizeTurnAbortReason} from "./abort.js";
import {randomUUID} from "node:crypto";

export interface RootTurnSnapshotState {
    todos: readonly Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    uiEvents: readonly PersistedUIEvent[];
}

export interface RootTurnLifecycleIssue {
    scope: "session" | "host";
    message: string;
    error: unknown;
}

export interface RunRootTurnOptions {
    turnId?: string;
    resources: RootRuntimeResources;
    session: RootSessionRuntime;
    prompt: MessageContent;
    signal: AbortSignal;
    host: ToolContextHost;
    onEvent(event: AgentEvent): void | Promise<void>;
    onHookResult(result: HookBatchResult): void | Promise<void>;
    onLifecycleIssue(issue: RootTurnLifecycleIssue): void | Promise<void>;
    onTurnSettled?(result: AgentResult | undefined): void;
    getSnapshotState(): RootTurnSnapshotState;
    sessionStartContextBlocks?: readonly string[];
    inputChannel?: AgentInputChannel;
    maxIterations?: number;
}

export type RootSessionSnapshotWriter = (session: RootSessionRuntime, snapshot: SaveSessionSnapshotInput) => Promise<void>;
interface RootTurnRunnerDependencies {saveSession: RootSessionSnapshotWriter}

export function createRootTurnRunnerFactory(
    overrides: Partial<RootTurnRunnerDependencies> = {}
) {
    const dependencies: RootTurnRunnerDependencies = {
        saveSession: overrides.saveSession ?? ((session, snapshot) => session.saveSnapshot(snapshot)),
    };

    return async function runRootTurn(
        options: RunRootTurnOptions
    ): Promise<AgentResult> {
        const {
            resources,
            session,
            prompt,
            signal,
            host,
            onEvent,
            onHookResult,
            onLifecycleIssue,
            onTurnSettled,
            getSnapshotState,
            sessionStartContextBlocks = [],
            inputChannel = EMPTY_AGENT_INPUT_CHANNEL,
            maxIterations,
        } = options;
        const turnId = options.turnId ?? randomUUID();
        const releaseHookTurn = resources.holdHookConfiguration();
        const memoryBaseline=host.getCollaborationMode()==="plan"?undefined:await resources.memory.captureBaseline(session.sessionId,contentText(prompt));
        const agentOptions: AgentRunOptions = {
            getToolSchemas: resources.toolRuntime.getToolSchemas,
            executeTool: resources.toolRuntime.executeTool,
            isToolConcurrencySafe: resources.toolRuntime.isConcurrencySafe,
            getTodos: () => getSnapshotState().todos,
            ...(maxIterations === undefined ? {} : {maxIterations}),
        };
        let sessionSaved = false;
        let hostSettled = false;
        let result: AgentResult | undefined;
        let interruptionEmitted = false;
        let failed = false;

        const emitEvent = (event: AgentEvent): void | Promise<void> => {
            if (event.type === "turn_interrupted") interruptionEmitted = true;
            return onEvent(event);
        };

        const settleHost = async (): Promise<void> => {
            if (hostSettled) return;
            hostSettled = true;
            try {
                onTurnSettled?.(result);
            } catch (error) {
                try {
                    await onLifecycleIssue({
                        scope: "host",
                        message: "Turn projection finalization failed",
                        error,
                    });
                } catch {
                    // Host diagnostic sinks cannot prevent Session saves.
                }
            }
        };

        try {
            const initialState = getSnapshotState();
            await session.beginTurn(prompt, initialState);
            const ctx = session.createContext({signal, host, onEvent: emitEvent, turnId, getSnapshotState});
            const promptHooks = await ctx.runHook!({hook_event_name: "UserPromptSubmit", session_id: session.sessionId,
                turn_id: turnId, prompt: contentText(prompt), permission_mode: initialState.permissionMode});
            await onHookResult(promptHooks);

            result = promptHooks.error ? {reply: `UserPromptSubmit Hook error: ${promptHooks.error}`, reason: "hook_error", iterations: 0}
                : promptHooks.blocked
                ? {
                    reply: `UserPromptSubmit Hook blocked the request: ${promptHooks.blockReason ?? "No reason provided"}`,
                    reason: "hook_blocked",
                    iterations: 0,
                }
                : await resources.agentRuntime.runAgent(
                    prompt,
                    session.history,
                    emitEvent,
                    ctx,
                    inputChannel,
                    {
                        ...agentOptions,
                        additionalUserContextBlocks: [
                            ...sessionStartContextBlocks,
                            ...formatHookContext(
                                "UserPromptSubmit",
                                promptHooks.additionalContexts
                            ),
                        ],
                    }
                );
            if (promptHooks.blocked || promptHooks.error) {
                await emitEvent({type: "assistant_text", content: result.reply});
            }

            await settleHost();
            await dependencies.saveSession(
                session,
                session.createSnapshot(getSnapshotState())
            );
            sessionSaved = true;
            if(result.reason==="completed"&&!signal.aborted&&memoryBaseline&&host.getCollaborationMode()!=="plan"){
                try {await session.taskSession.startMemory({turnId,signal,background:true,baseline:memoryBaseline});}
                catch(error){try{await onLifecycleIssue({scope:"host",message:"Memory source scheduling failed; main task result was saved",error});}catch{}}
            }
            return result;
        } catch (error) {
            failed = true;
            if (signal.aborted && !interruptionEmitted) {
                await emitEvent({
                    type: "turn_interrupted",
                    reason: normalizeTurnAbortReason(signal.reason),
                });
            }
            throw error;
        } finally {
            await settleHost();
            session.endTurn();
            if (!sessionSaved) {
                try {
                    await dependencies.saveSession(
                        session,
                        session.createSnapshot({
                            ...getSnapshotState(),
                            allowEmpty: true,
                            summaryHint: contentText(prompt),
                        })
                    );
                    sessionSaved = true;
                } catch (error) {
                    try {
                        await onLifecycleIssue({
                            scope: "session",
                            message: "Failed to save on the error path",
                            error,
                        });
                    } catch {
                        // Diagnostic sink failures must not replace the original Turn error.
                    }
                }
            }
            try {
                const input: Extract<HookInput, {hook_event_name: "TurnEnd"}> = {
                    hook_event_name: "TurnEnd", session_id: session.sessionId, turn_id: turnId,
                    status: signal.aborted || result?.reason === "interrupted" ? "cancelled"
                        : failed || !result || result.reason === "hook_error" || result.reason === "no_tool_calls" ? "failed"
                        : result.reason === "hook_blocked" || result.reason === "permission_denied" ? "blocked"
                        : result.reason === "max_turns" || result.reason === "hook_limit" ? "limit" : "completed",
                    reason: signal.aborted ? normalizeTurnAbortReason(signal.reason) : failed ? "error" : result?.reason ?? "error",
                    persistence_status: sessionSaved ? "saved" : "failed",
                };
                await emitEvent({type: "turn_end", input});
                // Cancellation reports a fact only; never create a fresh signal for notifications.
                if (!signal.aborted) {
                    const ctx = session.createContext({signal, host, onEvent: emitEvent, turnId, getSnapshotState});
                    await onHookResult(await ctx.runHook!(input));
                }
            } catch (error) {
                try {await onLifecycleIssue({scope: "host", message: "TurnEnd Hook diagnostics failed", error});} catch {}
            } finally {releaseHookTurn();}
        }
    };
}

export const runRootTurn = createRootTurnRunnerFactory();
