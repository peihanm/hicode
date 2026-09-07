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
    saveSessionSnapshot,
    type PersistedUIEvent,
} from "../session/index.js";
import type {Todo} from "../todos.js";
import type {ToolContextHost} from "./toolContext.js";
import type {RootRuntimeResources} from "./resources.js";
import type {RootSessionRuntime} from "./sessionRuntime.js";
import {normalizeTurnAbortReason} from "./abort.js";
import {randomUUID} from "node:crypto";
import {TurnTiming} from "./turnTiming.js";

export interface RootTurnSnapshotState {
    todos: readonly Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    uiEvents: readonly PersistedUIEvent[];
}

export interface RootTurnLifecycleIssue {
    scope: "checkpoint" | "session" | "host";
    message: string;
    error: unknown;
}

export interface RunRootTurnOptions {
    turnId?: string;
    resources: RootRuntimeResources;
    session: RootSessionRuntime;
    prompt: string;
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

interface RootTurnRunnerDependencies {
    saveSession: typeof saveSessionSnapshot;
}

export function createRootTurnRunnerFactory(
    overrides: Partial<RootTurnRunnerDependencies> = {}
) {
    const dependencies: RootTurnRunnerDependencies = {
        saveSession: overrides.saveSession ?? saveSessionSnapshot,
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
        const timing = new TurnTiming();
        const turnId = options.turnId ?? randomUUID();
        const releaseHookTurn = resources.holdHookConfiguration();
        let timingEmitted = false;
        const memoryBaseline=host.getPermissionMode()==="readOnly"||host.getCollaborationMode()==="plan"?undefined:await resources.memory.captureBaseline(session.sessionId,prompt);
        const agentOptions: AgentRunOptions = {
            getToolSchemas: resources.toolRuntime.getToolSchemas,
            executeTool: resources.toolRuntime.executeTool,
            isToolConcurrencySafe: resources.toolRuntime.isConcurrencySafe,
            getTodos: () => getSnapshotState().todos,
            ...(maxIterations === undefined ? {} : {maxIterations}),
        };
        let checkpointSettled = false;
        let sessionSaved = false;
        let hostSettled = false;
        let result: AgentResult | undefined;
        let interruptionEmitted = false;
        let failed = false;

        const emitEvent = (event: AgentEvent): void | Promise<void> => {
            if (event.type === "turn_interrupted") interruptionEmitted = true;
            if (event.type === "model_stream_start" || event.type === "compact_start") timing.change("model", "start");
            if (event.type === "model_stream_end" || event.type === "compact_end" || event.type === "compact_error") timing.change("model", "end");
            return onEvent(event);
        };

        const finishTiming = async (): Promise<void> => {
            if (timingEmitted) return;
            timingEmitted = true;
            try {
                await emitEvent({type: "turn_timing", turnId, timing: timing.finish()});
            } catch (error) {
                try {
                    await onLifecycleIssue({scope: "host", message: "Turn 耗时投影失败", error});
                } catch {
                    // Optional diagnostics must not prevent saving the conversation.
                }
            }
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
                        message: "Turn 投影收尾失败",
                        error,
                    });
                } catch {
                    // Host 诊断 sink 不能阻止 Checkpoint 与 Session 保存。
                }
            }
        };

        try {
            const initialState = getSnapshotState();
            await session.beginCheckpoint(prompt, initialState);
            const ctx = session.createContext({signal, host, onEvent: emitEvent, turnId, getSnapshotState});
            ctx.canUseTool = (...args) => timing.measure("approval", () => host.canUseTool(...args));
            ctx.onToolExecution = phase => timing.change("tool", phase);
            const promptHooks = await ctx.runHook!({hook_event_name: "UserPromptSubmit", session_id: session.sessionId,
                turn_id: turnId, prompt, permission_mode: initialState.permissionMode});
            await onHookResult(promptHooks);

            result = promptHooks.error ? {reply: `UserPromptSubmit Hook 故障: ${promptHooks.error}`, reason: "hook_error", iterations: 0}
                : promptHooks.blocked
                ? {
                    reply: `UserPromptSubmit Hook 阻止了请求: ${promptHooks.blockReason ?? "未提供原因"}`,
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
            await session.settleCheckpoint(
                (promptHooks.blocked || promptHooks.error) ? "no_agent_run" : "settled"
            );
            checkpointSettled = true;
            await finishTiming();
            await dependencies.saveSession(
                resources.storage,
                session.createSnapshot(getSnapshotState())
            );
            sessionSaved = true;
            if(result.reason==="completed"&&!signal.aborted&&memoryBaseline&&host.getPermissionMode()!=="readOnly"&&host.getCollaborationMode()!=="plan"){
                try {await session.taskSession.startMemory({turnId,signal,background:true,baseline:memoryBaseline});}
                catch(error){try{await onLifecycleIssue({scope:"host",message:"Memory 来源调度失败，主任务结果已保存",error});}catch{}}
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
            if (!checkpointSettled) {
                try {
                    await session.settleCheckpoint("settled");
                    checkpointSettled = true;
                } catch (error) {
                    try {
                        await onLifecycleIssue({
                            scope: "checkpoint",
                            message: "异常路径收尾失败",
                            error,
                        });
                    } catch {
                        // 诊断 sink 失败不能阻止后续 Session 保存。
                    }
                }
            }
            if (!sessionSaved) {
                try {
                    await finishTiming();
                    await dependencies.saveSession(
                        resources.storage,
                        session.createSnapshot({
                            ...getSnapshotState(),
                            allowEmpty: true,
                            summaryHint: prompt,
                        })
                    );
                    sessionSaved = true;
                } catch (error) {
                    try {
                        await onLifecycleIssue({
                            scope: "session",
                            message: "异常路径保存失败",
                            error,
                        });
                    } catch {
                        // 诊断 sink 失败不能覆盖原始 Turn 错误。
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
                    persistence_status: sessionSaved ? "saved" : "failed", checkpoint_status: checkpointSettled ? "settled" : "failed",
                };
                await emitEvent({type: "turn_end", input});
                // Cancellation reports a fact only; never create a fresh signal for notifications.
                if (!signal.aborted) {
                    const ctx = session.createContext({signal, host, onEvent: emitEvent, turnId, getSnapshotState});
                    await onHookResult(await ctx.runHook!(input));
                }
            } catch (error) {
                try {await onLifecycleIssue({scope: "host", message: "TurnEnd Hook 诊断失败", error});} catch {}
            } finally {releaseHookTurn();}
        }
    };
}

export const runRootTurn = createRootTurnRunnerFactory();
