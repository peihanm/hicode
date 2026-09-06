import type {AgentEvent, AgentResult} from "../agent/types.js";
import {
    EMPTY_AGENT_INPUT_CHANNEL,
    type AgentInputChannel,
    type AgentRunOptions,
} from "../agent/index.js";
import {formatHookContext, type HookBatchResult} from "../hooks/index.js";
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
        const timingTurnId = randomUUID();
        let timingEmitted = false;
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
                await emitEvent({type: "turn_timing", turnId: timingTurnId, timing: timing.finish()});
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
            const ctx = session.createContext({signal, host, onEvent: emitEvent});
            ctx.canUseTool = (...args) => timing.measure("approval", () => host.canUseTool(...args));
            ctx.onToolExecution = phase => timing.change("tool", phase);
            const promptHooks = await session.runUserPromptHooks(
                prompt,
                initialState.permissionMode,
                signal
            );
            await onHookResult(promptHooks);

            result = promptHooks.blocked
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
            if (promptHooks.blocked) {
                await emitEvent({type: "assistant_text", content: result.reply});
            }

            await settleHost();
            await session.settleCheckpoint(
                promptHooks.blocked ? "no_agent_run" : "settled"
            );
            checkpointSettled = true;
            await finishTiming();
            await dependencies.saveSession(
                resources.storage,
                session.createSnapshot(getSnapshotState())
            );
            sessionSaved = true;
            return result;
        } catch (error) {
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
        }
    };
}

export const runRootTurn = createRootTurnRunnerFactory();
