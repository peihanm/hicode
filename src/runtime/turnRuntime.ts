import type {AgentEvent, AgentResult} from "../agent/types.js";
import {
    EMPTY_AGENT_INPUT_CHANNEL,
    type AgentInputChannel,
    type AgentRunOptions,
} from "../agent/index.js";
import {formatHookContext, type HookBatchResult} from "../hooks/index.js";
import type {PermissionMode} from "../permissions/index.js";
import {
    saveSessionSnapshot,
    type PersistedUIEvent,
} from "../session/index.js";
import type {Todo} from "../todos.js";
import type {ToolContextHost} from "./toolContext.js";
import type {RootRuntimeResources} from "./resources.js";
import type {RootSessionRuntime} from "./sessionRuntime.js";

export interface RootTurnSnapshotState {
    todos: readonly Todo[];
    permissionMode: PermissionMode;
    prePlanMode?: PermissionMode;
    uiEvents: readonly PersistedUIEvent[];
}

export interface RootTurnLifecycleIssue {
    scope: "checkpoint" | "session";
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
            getSnapshotState,
            sessionStartContextBlocks = [],
            inputChannel = EMPTY_AGENT_INPUT_CHANNEL,
            maxIterations,
        } = options;
        const agentOptions: AgentRunOptions = {
            getToolSchemas: resources.toolRuntime.getToolSchemas,
            executeTool: resources.toolRuntime.executeTool,
            isToolConcurrencySafe: resources.toolRuntime.isConcurrencySafe,
            getTodos: () => getSnapshotState().todos,
            ...(maxIterations === undefined ? {} : {maxIterations}),
        };
        let checkpointSettled = false;
        let sessionSaved = false;

        try {
            const initialState = getSnapshotState();
            await session.beginCheckpoint(prompt, initialState);
            const ctx = session.createContext({signal, host, onEvent});
            const promptHooks = await session.runUserPromptHooks(
                prompt,
                initialState.permissionMode,
                signal
            );
            await onHookResult(promptHooks);

            const result: AgentResult = promptHooks.blocked
                ? {
                    reply: `UserPromptSubmit Hook 阻止了请求: ${promptHooks.blockReason ?? "未提供原因"}`,
                    reason: "hook_blocked",
                    iterations: 0,
                }
                : await resources.agentRuntime.runAgent(
                    prompt,
                    session.history,
                    onEvent,
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
                await onEvent({type: "assistant_text", content: result.reply});
            }

            await session.settleCheckpoint(
                promptHooks.blocked ? "no_agent_run" : "settled"
            );
            checkpointSettled = true;
            await dependencies.saveSession(
                resources.storage,
                session.createSnapshot(getSnapshotState())
            );
            sessionSaved = true;
            return result;
        } finally {
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
