import {randomUUID} from "node:crypto";
import {DEFAULT_MAX_ITERATIONS} from "../agent/constants.js";
import type {AgentRunner} from "../agent/runner.js";
import {createCompactState} from "../context/state.js";
import type {ToolResultStore} from "../toolResults/index.js";
import {createToolRuntime} from "../tools/registry.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentEvent} from "../agent/types.js";
import type {Message} from "../llm/types.js";
import {createToolContext} from "../runtime/toolContext.js";
import {createAgentSystemPrompt} from "./prompt.js";
import type {SubagentRegistry} from "./registry.js";
import {SubagentTranscriptWriter} from "./transcript.js";
import type {
    CreateSubagentRunner,
    CreateSubagentRunnerOptions,
    CreateSubagentThread,
    ForkSubagentRequest,
    SubagentRequest,
    SubagentResult,
    SubagentThread,
} from "./types.js";
import {createDisabledFileCheckpointRuntime} from "../checkpoints/index.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../agent/inputChannel.js";
import {createForkDirective} from "./fork.js";
import type {SubagentRegistration} from "./registration.js";
import {resolveSubagentModel} from "./model.js";
import {createFileStateTracker} from "../tools/shared/fileState.js";

interface SubagentRunnerDependencies {
    primaryRunAgent: AgentRunner;
    fastRunAgent: AgentRunner;
    fastModel: string;
    registry: SubagentRegistry;

    createToolResultStore(cwd: string, sessionId: string): ToolResultStore;
}

const DEFAULT_FINALIZE_PROMPT = [
    "工具调查阶段已经结束。",
    "现在禁止继续调用工具，请只根据当前 history 中已经获得的证据输出最终调查报告。",
    "报告应直接回答原始任务，列出关键文件和结论，并明确任何尚未确认的部分。",
].join("\n");

const READONLY_FORK_TOOLS = [
    "list_files",
    "glob",
    "read_file",
    "grep",
    "lsp",
    "read_tool_result",
] as const;

const WORKTREE_FORK_TOOLS = [
    "list_files",
    "glob",
    "read_file",
    "grep",
    "edit_file",
    "write_file",
    "delete_file",
    "read_tool_result",
] as const;

function createForkRegistration(
    request: ForkSubagentRequest,
    parentContext: ToolContext
): SubagentRegistration {
    const allowedTools = request.isolation === "worktree"
        ? WORKTREE_FORK_TOOLS
        : READONLY_FORK_TOOLS;
    return {
        definition: {
            agentType: "fork",
            whenToUse: request.description,
            systemPrompt: "临时 Fork 继承父 History，不使用持久 Agent Prompt。",
            allowedTools,
            model: "inherit",
            maxIterations: 12,
            source: "builtin",
        },
        concurrencySafe: request.isolation !== "worktree",
        createRuntimeConfig() {
            return {
                toolRuntimeOptions: {allowedToolNames: allowedTools},
                contextResources: {
                    storage: parentContext.storage,
                    cwd: parentContext.cwd,
                    workspaceBoundary:
                        parentContext.workspaceBoundary ?? parentContext.cwd,
                    skills: [],
                    instructions: parentContext.instructions,
                    lspManager: request.isolation === "worktree"
                        ? undefined
                        : parentContext.lspManager,
                    gitSession: parentContext.gitSession,
                    shellRunner: parentContext.shellRunner,
                },
                permissionRules: {
                    allow: [],
                    ask: [],
                    deny: [...parentContext.permissionRules.deny],
                },
                permissionMode: request.isolation === "worktree"
                    ? "default"
                    : "readOnly",
                collaborationMode: "build",
                permissionPromptPolicy: "never",
            };
        },
    };
}

async function emit(
    callback: CreateSubagentRunnerOptions["onEvent"],
    event: AgentEvent
): Promise<void> {
    await callback(event);
}

export function createSubagentFactories(
    dependencies: SubagentRunnerDependencies
): {
    createSubagentRunner: CreateSubagentRunner;
    createSubagentThread: CreateSubagentThread;
} {
    const createSubagentThread: CreateSubagentThread = (options, request) => {
        const {parentContext, onEvent, onChildEvent, agentId} = options;
        const registration = request.kind === "fork"
            ? createForkRegistration(request, parentContext)
            : dependencies.registry.get(request.agentType);
        if (!registration) {
            const available = dependencies.registry
                .listDefinitions()
                .map((definition) => definition.agentType)
                .join(", ");
            throw new Error(
                `未知 Agent 类型: ${request.agentType}。当前可用: ${available}`
            );
        }
        const {definition} = registration;
        const runtimeConfig = registration.createRuntimeConfig(parentContext);
        const runtime = createToolRuntime(runtimeConfig.toolRuntimeOptions);
        const initialToolNames = runtime.getToolSchemas()
            .map((tool) => tool.function.name);
        const modelSelection = request.kind !== "fork"
            ? request.model ?? definition.model
            : "inherit";
        const childModel = resolveSubagentModel({
            definitionModel: definition.model,
            parentModel: parentContext.model,
            fastModel: dependencies.fastModel,
            override: request.kind !== "fork"
                ? request.model
                : undefined,
        });
        const runChildAgent = modelSelection === "fast"
            ? dependencies.fastRunAgent
            : dependencies.primaryRunAgent;
        const childProvider = modelSelection === "fast"
            ? parentContext.fastProvider
            : parentContext.provider;
        const childSessionId = `subagent-${agentId}`;
        const childHistory: Message[] = request.kind === "fork"
            ? structuredClone(request.contextSnapshot.history)
            : [{
                role: "system",
                content: createAgentSystemPrompt(
                    definition,
                    parentContext.cwd,
                    childModel,
                    initialToolNames
                ),
            }];
        const childCompactState = createCompactState();
        const childFileState = createFileStateTracker();
        const childToolResultStore = dependencies.createToolResultStore(
            options.storageCwd ?? parentContext.cwd,
            childSessionId
        );
        const childFileCheckpoints =
            runtimeConfig.toolRuntimeOptions.allowedToolNames?.some(
                (name) => name === "edit_file" ||
                    name === "write_file" ||
                    name === "delete_file"
            )
                ? parentContext.fileCheckpoints
                : createDisabledFileCheckpointRuntime();
        const transcript = new SubagentTranscriptWriter(
            parentContext.storage,
            options.storageCwd ?? parentContext.cwd,
            parentContext.sessionId,
            agentId
        );
        let transcriptPath: string | undefined;
        let transcriptStarted = false;
        let transcriptDisabled = false;
        let running = false;
        let runCount = 0;

        const thread: SubagentThread = {
            agentId,
            async run(input) {
                if (running) {
                    throw new Error(`Agent Thread 正在运行: ${agentId}`);
                }
                running = true;
                try {
                    const firstRun = runCount === 0;
                    runCount += 1;
                    const childContext: ToolContext = createToolContext({
                        signal: input.signal,
                        // 逐字段构造，禁止未来 capability 被 Root resources 自动扩散到 Child。
                        resources: {
                            ...runtimeConfig.contextResources,
                            // Child 只能凭自己实际读取过的内容获得编辑授权。
                            fileState: childFileState,
                            model: childModel,
                            provider: childProvider,
                            fastModel: dependencies.fastModel,
                            fastProvider: parentContext.fastProvider,
                        },
                        session: {
                            sessionId: childSessionId,
                            compactState: childCompactState,
                            toolResultStore: childToolResultStore,
                            fileCheckpoints: childFileCheckpoints,
                        },
                        host: {
                            canUseTool: async () => ({
                                behavior: "deny",
                                message: "子 Agent 不允许交互式权限确认",
                            }),
                            getPermissionRules: () => runtimeConfig.permissionRules,
                            getPermissionMode: () => runtimeConfig.permissionMode,
                            getCollaborationMode: () => runtimeConfig.collaborationMode,
                            getPermissionPromptPolicy: () =>
                                runtimeConfig.permissionPromptPolicy,
                            setPermissionMode() {
                            },
                            setCollaborationMode() {
                            },
                            setTodos() {
                            },
                        },
                    });
                    // subagentLauncher 故意缺失，形成不可递归的运行时边界。
                    if (!transcriptStarted && !transcriptDisabled) {
                        try {
                            await transcript.append({
                                type: "start",
                                version: 1,
                                timestamp: new Date().toISOString(),
                                parentSessionId: parentContext.sessionId,
                                parentToolCallId: request.parentToolCallId,
                                agentId,
                                agentType: definition.agentType,
                                ...(request.kind === "fork"
                                    ? {agentName: request.name}
                                    : {}),
                                description: request.description,
                                model: childModel,
                                cwd: parentContext.cwd,
                                allowedTools: runtime.toolNames,
                            });
                            transcriptPath = transcript.path;
                            transcriptStarted = true;
                        } catch {
                            transcriptDisabled = true;
                        }
                    }

                    await emit(onEvent, {
                        type: "subagent_start",
                        agentId,
                        agentType: definition.agentType,
                        ...(request.kind === "fork" ? {agentName: request.name} : {}),
                        description: request.description,
                        parentToolCallId: request.parentToolCallId,
                    });
                    const startedAt = Date.now();
                    let toolUseCount = 0;
                    const recordChildEvent = async (event: AgentEvent): Promise<void> => {
                        if (event.type === "tool_call_start") toolUseCount += 1;
                        if (transcriptPath) {
                            try {
                                await transcript.append({
                                    type: "event",
                                    timestamp: new Date().toISOString(),
                                    event,
                                });
                            } catch {
                                transcriptPath = undefined;
                                transcriptDisabled = true;
                            }
                        }
                        if (event.type === "tool_call_start") {
                            await emit(onEvent, {
                                type: "subagent_progress",
                                agentId,
                                event: {
                                    type: "tool_start",
                                    toolCallId: event.toolCallId,
                                    name: event.name,
                                    args: event.args,
                                },
                            });
                        } else if (event.type === "tool_call_end") {
                            await emit(onEvent, {
                                type: "subagent_progress",
                                agentId,
                                event: {
                                    type: "tool_end",
                                    toolCallId: event.toolCallId,
                                },
                            });
                        } else if (event.type === "token_update") {
                            await emit(onEvent, {
                                type: "subagent_progress",
                                agentId,
                                event: {
                                    type: "token_update",
                                    tokenCount: event.tokenCount,
                                },
                            });
                        }
                        await onChildEvent?.(event);
                    };
                    const totalBudget = definition.maxIterations ?? DEFAULT_MAX_ITERATIONS;
                    const explorationBudget = Math.max(1, totalBudget - 1);
                    const childPrompt = firstRun && request.kind === "fork"
                        ? createForkDirective({
                            name: request.name,
                            description: request.description,
                            prompt: input.prompt,
                            writable: request.isolation === "worktree",
                        })
                        : input.prompt;
                    let result = await runChildAgent(
                        childPrompt,
                        childHistory,
                        recordChildEvent,
                        childContext,
                        input.inputChannel,
                        {
                            maxIterations: explorationBudget,
                            getToolSchemas: runtime.getToolSchemas,
                            isToolConcurrencySafe: runtime.isConcurrencySafe,
                            executeTool: runtime.executeTool,
                            ...(runtimeConfig.maxConsecutiveDeniedToolCalls !== undefined
                                ? {
                                    maxConsecutiveDeniedToolCalls:
                                        runtimeConfig.maxConsecutiveDeniedToolCalls,
                                }
                                : {}),
                        }
                    );
                    let totalIterations = result.iterations;
                    if (
                        (result.reason === "max_turns" ||
                            result.reason === "permission_denied") &&
                        !input.signal.aborted &&
                        totalBudget > 1
                    ) {
                        const finalized = await runChildAgent(
                            registration.finalizePrompt ?? DEFAULT_FINALIZE_PROMPT,
                            childHistory,
                            recordChildEvent,
                            childContext,
                            input.inputChannel,
                            {
                                maxIterations: 1,
                                getToolSchemas: () => [],
                                isToolConcurrencySafe: runtime.isConcurrencySafe,
                                executeTool: runtime.executeTool,
                            }
                        );
                        result = finalized;
                        totalIterations += finalized.iterations;
                    }
                    const subagentResult: SubagentResult = {
                        agentId,
                        agentType: definition.agentType,
                        ...(request.kind === "fork" ? {agentName: request.name} : {}),
                        description: request.description,
                        reply: result.reply,
                        reason: result.reason,
                        iterations: totalIterations,
                        toolUseCount,
                        durationMs: Date.now() - startedAt,
                        ...(transcriptPath ? {transcriptPath} : {}),
                        ...(registration.parseResult?.(result.reply) ?? {}),
                    };

                    if (transcriptPath) {
                        try {
                            await transcript.append({
                                type: "snapshot",
                                timestamp: new Date().toISOString(),
                                history: childHistory,
                                result: subagentResult,
                            });
                        } catch {
                            transcriptPath = undefined;
                            transcriptDisabled = true;
                            delete subagentResult.transcriptPath;
                        }
                    }

                    await emit(onEvent, {
                        type: "subagent_end",
                        agentId,
                        agentType: definition.agentType,
                        ...(request.kind === "fork" ? {agentName: request.name} : {}),
                        reason: subagentResult.reason,
                        iterations: subagentResult.iterations,
                        toolUseCount: subagentResult.toolUseCount,
                        durationMs: subagentResult.durationMs,
                        report: subagentResult.reply,
                        ...(subagentResult.verificationVerdict
                            ? {verificationVerdict: subagentResult.verificationVerdict}
                            : {}),
                        ...(subagentResult.transcriptPath
                            ? {transcriptPath: subagentResult.transcriptPath}
                            : {}),
                    });
                    return subagentResult;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (transcriptPath) {
                        try {
                            await transcript.append({
                                type: "event",
                                timestamp: new Date().toISOString(),
                                event: {
                                    type: "subagent_error",
                                    agentId,
                                    agentType: definition.agentType,
                                    message,
                                },
                            });
                        } catch {
                            // 保留原始运行错误。
                        }
                    }
                    await emit(onEvent, {
                        type: "subagent_error",
                        agentId,
                        agentType: definition.agentType,
                        ...(request.kind === "fork" ? {agentName: request.name} : {}),
                        message,
                    });
                    throw error;
                } finally {
                    running = false;
                }
            },
        };
        return thread;
    };

    const createSubagentRunner: CreateSubagentRunner = (
        options: CreateSubagentRunnerOptions
    ) => async (request: SubagentRequest): Promise<SubagentResult> => {
        const agentId = randomUUID();
        const thread = createSubagentThread({
            parentContext: options.parentContext,
            onEvent: options.onEvent,
            agentId,
        }, request);
        return thread.run({
            prompt: request.prompt,
            signal: options.parentContext.signal,
            inputChannel: EMPTY_AGENT_INPUT_CHANNEL,
        });
    };

    return {createSubagentRunner, createSubagentThread};
}
