import type {AgentRunOptions} from "../agent/index.js";
import type {PermissionDecision} from "../permissions/index.js";
import {createRootRuntimeResources} from "../runtime/resources.js";
import {createTurnAbortController} from "../runtime/abort.js";
import {saveSessionSnapshot} from "../session/index.js";
import {createToolResultStore, type ToolResultStore,} from "../toolResults/index.js";
import type {AgentEvent} from "../agent/types.js";
import {HeadlessEventCollector} from "./collector.js";
import {writeHeadlessDiagnostic, writeHeadlessOutput} from "./io.js";
import {buildHeadlessRunSummary, formatHeadlessProgress,} from "./output.js";
import {loadHeadlessSession} from "./session.js";
import type {HeadlessOptions, HeadlessOutputFormat, HeadlessRunSummary,} from "./types.js";
import {formatAgentLoadIssue} from "../subagents/diagnostics.js";
import {formatHookContext, getHookExecutionIssues, type HookBatchResult,} from "../hooks/index.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../agent/inputChannel.js";
import {createRootSessionRuntime} from "../runtime/sessionRuntime.js";

type CreateToolResultStore = (cwd: string, sessionId: string) => ToolResultStore;

interface HeadlessRunnerDependencies {
    createResources: typeof createRootRuntimeResources;
    createToolResultStore: CreateToolResultStore;
    saveSession: typeof saveSessionSnapshot;
    writeOutput: (
        summary: HeadlessRunSummary,
        format: HeadlessOutputFormat
    ) => void | Promise<void>;
    writeDiagnostic: (line: string) => void | Promise<void>;
}

export function createHeadlessRunner(
    overrides: Partial<HeadlessRunnerDependencies> = {}
) {
    const dependencies: HeadlessRunnerDependencies = {
        createResources:
            overrides.createResources ?? createRootRuntimeResources,
        createToolResultStore:
            overrides.createToolResultStore ??
            createToolResultStore,
        saveSession: overrides.saveSession ?? saveSessionSnapshot,
        writeOutput: overrides.writeOutput ?? writeHeadlessOutput,
        writeDiagnostic: overrides.writeDiagnostic ?? writeHeadlessDiagnostic,
    };

    return async function runHeadless(
        options: HeadlessOptions,
        signal?: AbortSignal
    ): Promise<HeadlessRunSummary> {
        const state = loadHeadlessSession(options);
        const permissionRules = options.settings.permissions.rules;
        const collector = new HeadlessEventCollector();
        const fallbackController = createTurnAbortController();
        const activeSignal = signal ?? fallbackController.signal;
        const resources = await dependencies.createResources({
            cwd: options.cwd,
            settings: options.settings,
            signal: activeSignal,
            headless: true,
        });
        const rootSession = createRootSessionRuntime({
            resources,
            seed: {
                sessionId: state.sessionId,
                history: state.history,
                compactState: state.compactState,
                checkpointHead: state.checkpointHead,
                toolDiscovery: state.toolDiscovery,
                gitSession: state.gitSession,
            },
            toolResultStore: dependencies.createToolResultStore(
                options.cwd,
                state.sessionId
            ),
            resumed: options.resumeMode.kind !== "none",
            allowBackgroundTasks: false,
        });
        await rootSession.initialize();
        const agentOptions: AgentRunOptions = {
            getToolSchemas: resources.toolRuntime.getToolSchemas,
            executeTool: resources.toolRuntime.executeTool,
            isToolConcurrencySafe: resources.toolRuntime.isConcurrencySafe,
        };
        const eventHandler = async (event: AgentEvent): Promise<void> => {
            collector.handleEvent(event);
            if (options.outputFormat !== "text") return;
            const line = formatHeadlessProgress(event);
            if (line !== null) await dependencies.writeDiagnostic(line);
        };

        const writeHookIssues = async (result: HookBatchResult) => {
            for (const issue of getHookExecutionIssues(result)) {
                await dependencies.writeDiagnostic(`Hook: ${issue}`);
            }
        };
        let sessionEndReason = "error";
        let checkpointSettled = false;
        let sessionSaved = false;

        try {
            if (resources.sandbox.status.kind === "unavailable") {
                await dependencies.writeDiagnostic(
                    `Sandbox unavailable: ${resources.sandbox.status.reason}`
                );
            }
            for (const issue of resources.subagents.issues) {
                await dependencies.writeDiagnostic(
                    `Agent 配置: ${formatAgentLoadIssue(issue)}`
                );
            }
            for (const issue of resources.hooks.issues) {
                await dependencies.writeDiagnostic(`Hook: ${issue.message}`);
            }
            const ctx = rootSession.createContext({
                signal: activeSignal,
                onEvent: eventHandler,
                host: {
                    canUseTool: async (
                        toolName,
                        message
                    ): Promise<PermissionDecision> => ({
                        behavior: "deny",
                        message: [
                            `headless 模式不能交互确认工具 ${toolName}`,
                            message,
                            "请使用 --permission-mode acceptEdits、--dangerously-skip-permissions 或配置 allow 规则。",
                        ].join("\n"),
                    }),
                    getPermissionRules: () => permissionRules,
                    getPermissionMode: () => state.permissionMode,
                    getPrePlanMode: () => state.prePlanMode,
                    setPermissionMode(mode) {
                        if (mode === "plan" && state.permissionMode !== "plan") {
                            state.prePlanMode = state.permissionMode;
                        } else if (state.permissionMode === "plan" && mode !== "plan") {
                            state.prePlanMode = undefined;
                        }
                        state.permissionMode = mode;
                    },
                    setTodos(todos) {
                        state.todos = todos;
                    },
                },
            });

            const sessionStart = await rootSession.runSessionStart(
                options.resumeMode.kind === "none" ? "startup" : "resume",
                activeSignal
            );
            await writeHookIssues(sessionStart);
            try {
                await rootSession.beginCheckpoint(options.prompt, {
                    todos: state.todos,
                    permissionMode: state.permissionMode,
                    prePlanMode: state.prePlanMode,
                    uiEvents: state.uiEvents,
                });
            } catch (error) {
                await dependencies.writeDiagnostic(
                    `Checkpoint: 创建失败，本轮修改可能无法恢复：${error instanceof Error ? error.message : String(error)}`
                );
            }

            const promptHooks = await rootSession.runUserPromptHooks(
                options.prompt,
                state.permissionMode,
                activeSignal
            );
            await writeHookIssues(promptHooks);

            const hookContexts = [
                ...formatHookContext(
                    "SessionStart",
                    sessionStart.additionalContexts
                ),
                ...formatHookContext(
                    "UserPromptSubmit",
                    promptHooks.additionalContexts
                ),
            ];

            const result = promptHooks.blocked
                ? {
                    reply: `UserPromptSubmit Hook 阻止了请求: ${promptHooks.blockReason ?? "未提供原因"}`,
                    reason: "hook_blocked" as const,
                    iterations: 0,
                }
                : await resources.agentRuntime.runAgent(
                    options.prompt,
                    state.history,
                    eventHandler,
                    ctx,
                    EMPTY_AGENT_INPUT_CHANNEL,
                    {
                        ...agentOptions,
                        additionalUserContextBlocks: hookContexts,
                    }
                );
            try {
                await rootSession.settleCheckpoint(
                    promptHooks.blocked ? "no_agent_run" : "settled"
                );
                checkpointSettled = true;
            } catch (error) {
                await dependencies.writeDiagnostic(
                    `Checkpoint: 收尾失败：${error instanceof Error ? error.message : String(error)}`
                );
            }
            sessionEndReason = result.reason;
            const collectorSnapshot = collector.getSnapshot();
            await dependencies.saveSession(
                rootSession.createSnapshot({
                    todos: state.todos,
                    permissionMode: state.permissionMode,
                    prePlanMode: state.prePlanMode,
                    uiEvents: [
                        ...state.uiEvents,
                        ...collectorSnapshot.currentUIEvents,
                    ],
                })
            );
            sessionSaved = true;
            const summary = buildHeadlessRunSummary({
                result,
                sessionId: state.sessionId,
                permissionMode: state.permissionMode,
                collector: collectorSnapshot,
                mcpServers: resources.mcpManager?.getSnapshots() ?? [],
            });
            await dependencies.writeOutput(summary, options.outputFormat);
            return summary;
        } finally {
            if (!checkpointSettled) {
                try {
                    await rootSession.settleCheckpoint("settled");
                } catch (error) {
                    try {
                        await dependencies.writeDiagnostic(
                            `Checkpoint: 异常路径收尾失败：${error instanceof Error ? error.message : String(error)}`
                        );
                    } catch {
                        // 诊断输出失败不能阻止 Runtime 资源回收。
                    }
                }
            }
            if (!sessionSaved) {
                try {
                    const collectorSnapshot = collector.getSnapshot();
                    await dependencies.saveSession(rootSession.createSnapshot({
                        todos: state.todos,
                        permissionMode: state.permissionMode,
                        prePlanMode: state.prePlanMode,
                        uiEvents: [
                            ...state.uiEvents,
                            ...collectorSnapshot.currentUIEvents,
                        ],
                        allowEmpty: true,
                        summaryHint: options.prompt,
                    }));
                } catch (error) {
                    try {
                        await dependencies.writeDiagnostic(
                            `Session: 异常路径保存失败：${error instanceof Error ? error.message : String(error)}`
                        );
                    } catch {
                        // 诊断输出失败不能覆盖原始 Headless 错误。
                    }
                }
            }
            const endController = new AbortController();
            const timer = setTimeout(
                () => endController.abort("session-end-timeout"),
                1_500
            );
            timer.unref?.();
            try {
                try {
                    const endResult = await rootSession.runSessionEnd(
                        sessionEndReason,
                        endController.signal
                    );
                    await writeHookIssues(endResult);
                } catch (error) {
                    // SessionEnd 是 best-effort 清理，不能覆盖原任务结果，也不能
                    // 阻止 Root resources 关闭。
                    try {
                        await dependencies.writeDiagnostic(
                            `Hook: SessionEnd 执行失败: ${error instanceof Error ? error.message : String(error)}`
                        );
                    } catch {
                        // stderr sink 失败也不能破坏资源回收。
                    }
                }
            } finally {
                clearTimeout(timer);
                await resources.close();
            }
        }
    };
}

export const runHeadless = createHeadlessRunner();
