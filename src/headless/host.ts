import {importSelectedImages} from "../runtime/imageInput.js";
import type {MessageContent} from "../images/content.js";
import {recoverSessionBeforeStart} from "../checkpoints/rewind.js";
import type {AgentEvent} from "../agent/types.js";
import {formatHookContext, getHookExecutionIssues, type HookBatchResult,} from "../hooks/index.js";
import type {PermissionDecision} from "../permissions/index.js";
import {createTurnAbortController} from "../runtime/abort.js";
import {createRootRuntimeResources} from "../runtime/resources.js";
import {createRootSessionRuntime} from "../runtime/sessionRuntime.js";
import type {ToolContextHost} from "../runtime/toolContext.js";
import {createRootTurnRunnerFactory, type RootTurnLifecycleIssue,} from "../runtime/turnRuntime.js";
import {saveSessionSnapshot} from "../session/index.js";
import {formatAgentLoadIssue} from "../subagents/diagnostics.js";
import {HeadlessEventCollector} from "./collector.js";
import {writeHeadlessDiagnostic, writeHeadlessOutput} from "./io.js";
import {buildHeadlessRunSummary, formatHeadlessProgress,} from "./output.js";
import {loadHeadlessSession} from "./session.js";
import type {HeadlessOptions, HeadlessOutputFormat, HeadlessRunSummary,} from "./types.js";

interface HeadlessRunnerDependencies {
    createResources: typeof createRootRuntimeResources;
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
        saveSession: overrides.saveSession ?? saveSessionSnapshot,
        writeOutput: overrides.writeOutput ?? writeHeadlessOutput,
        writeDiagnostic: overrides.writeDiagnostic ?? writeHeadlessDiagnostic,
    };
    const runRootTurn = createRootTurnRunnerFactory({
        saveSession: dependencies.saveSession,
    });

    return async function runHeadless(
        options: HeadlessOptions,
        signal?: AbortSignal
    ): Promise<HeadlessRunSummary> {
        let state = loadHeadlessSession(options);
        const permissionRules = options.configuration.settings.permissions.rules;
        const collector = new HeadlessEventCollector();
        const fallbackController = createTurnAbortController();
        const activeSignal = signal ?? fallbackController.signal;
        const resources = await dependencies.createResources({
            configuration: options.configuration,
            signal: activeSignal,
            headless: true,
        });
        try {
            if (await recoverSessionBeforeStart(resources, state.sessionId)) state = loadHeadlessSession({...options, resumeMode: {kind: "session", sessionId: state.sessionId}});
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
                resumed: options.resumeMode.kind !== "none",
                allowBackgroundTasks: false,
            });
            await rootSession.initialize();
            const eventHandler = async (event: AgentEvent): Promise<void> => {
                collector.handleEvent(event);
                if (options.outputFormat !== "text" && event.type !== "hook_completed") return;
                const line = formatHeadlessProgress(event);
                if (line !== null) await dependencies.writeDiagnostic(line);
            };
            const writeHookIssues = async (result: HookBatchResult) => {
                for (const issue of getHookExecutionIssues(result)) {
                    await dependencies.writeDiagnostic(`Hook: ${issue}`);
                }
            };
            const writeLifecycleIssue = async (issue: RootTurnLifecycleIssue) => {
                const scope = issue.scope === "checkpoint"
                    ? "Checkpoint"
                    : issue.scope === "session"
                        ? "Session"
                        : "Host";
                await dependencies.writeDiagnostic(
                    `${scope}: ${issue.message}：${issue.error instanceof Error ? issue.error.message : String(issue.error)}`
                );
            };
            const getSnapshotState = () => ({
                todos: state.todos,
                permissionMode: state.permissionMode,
                collaborationMode: state.collaborationMode,
                uiEvents: [
                    ...state.uiEvents,
                    ...collector.getSnapshot().currentUIEvents,
                ],
            });
            const toolContextHost: ToolContextHost = {
                canUseTool: async (
                    toolName,
                    message
                ): Promise<PermissionDecision> => ({
                    behavior: "deny",
                    message: [
                        `headless 模式不能交互确认工具 ${toolName}`,
                        message,
                        "请使用 Default 的受限能力、--dangerously-skip-permissions 或配置 allow 规则。",
                    ].join("\n"),
                }),
                getPermissionRules: () => permissionRules,
                getPermissionMode: () => state.permissionMode,
                getCollaborationMode: () => state.collaborationMode,
                getPermissionPromptPolicy: () => "never",
                setPermissionMode(mode) {
                    state.permissionMode = mode;
                },
                setCollaborationMode(mode) {
                    state.collaborationMode = mode;
                },
                setTodos(todos) {
                    state.todos = todos;
                },
            };
            let sessionEndReason = "error";
            let turnInvoked = false;

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
                const sessionStart = await rootSession.runSessionStart(
                    options.resumeMode.kind === "none" ? "startup" : "resume",
                    activeSignal,
                    eventHandler
                );
                await writeHookIssues(sessionStart);
                const images = options.images?.length ? await importSelectedImages(options.images, resources, rootSession.createContext({
                    signal: activeSignal, host: toolContextHost, onEvent: eventHandler, getSnapshotState,
                })) : [];
                const prompt: MessageContent = images.length ? [{type: "text", text: options.prompt}, ...images] : options.prompt;
                turnInvoked = true;
                const result = await runRootTurn({
                    resources,
                    session: rootSession,
                    prompt,
                    signal: activeSignal,
                    host: toolContextHost,
                    onEvent: eventHandler,
                    onHookResult: writeHookIssues,
                    onLifecycleIssue: writeLifecycleIssue,
                    getSnapshotState,
                    sessionStartContextBlocks: formatHookContext(
                        "SessionStart",
                        sessionStart.additionalContexts
                    ),
                });
                sessionEndReason = result.reason;
                const collectorSnapshot = collector.getSnapshot();
                const summary = buildHeadlessRunSummary({
                    result,
                    sessionId: state.sessionId,
                    permissionMode: state.permissionMode,
                    collaborationMode: state.collaborationMode,
                    collector: collectorSnapshot,
                    mcpServers: resources.mcpManager?.getSnapshots() ?? [],
                });
                await dependencies.writeOutput(summary, options.outputFormat);
                return summary;
            } finally {
                if (!turnInvoked) {
                    try {
                        await rootSession.settleCheckpoint("settled");
                    } catch (error) {
                        try {
                            await writeLifecycleIssue({
                                scope: "checkpoint",
                                message: "异常路径收尾失败",
                                error,
                            });
                        } catch {
                            // 诊断输出失败不能阻止 Session 保存。
                        }
                    }
                    try {
                        await dependencies.saveSession(
                            resources.storage,
                            rootSession.createSnapshot({
                                ...getSnapshotState(),
                                allowEmpty: true,
                                summaryHint: options.prompt,
                            })
                        );
                    } catch (error) {
                        try {
                            await writeLifecycleIssue({
                                scope: "session",
                                message: "异常路径保存失败",
                                error,
                            });
                        } catch {
                            // 诊断输出失败不能覆盖原始 Headless 错误。
                        }
                    }
                }
                try {
                    const endResult = await rootSession.runSessionEnd(
                        sessionEndReason,
                        eventHandler
                    );
                    await writeHookIssues(endResult);
                } catch (error) {
                    try {
                        await dependencies.writeDiagnostic(
                            `Hook: SessionEnd 执行失败: ${error instanceof Error ? error.message : String(error)}`
                        );
                    } catch {
                        // stderr sink 失败也不能破坏资源回收。
                    }
                }
            }
        } finally {
            await resources.close();
        }
    };
}

export const runHeadless = createHeadlessRunner();
