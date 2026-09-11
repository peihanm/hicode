import {throwIfTurnAborted} from "../runtime/abort.js";
import {ContextUsageTracker} from "../context/usage.js";
import {persistPreparedImage} from "../images/persist.js";
import {imageReferences} from "../images/content.js";
import type {HookInput} from "../hooks/types.js";
import {randomUUID} from "node:crypto";
import {DEFAULT_SUBAGENT_MAX_ITERATIONS} from "../agent/constants.js";
import type {AgentRunner} from "../agent/runner.js";
import {createCompactState} from "../context/state.js";
import type {ToolResultStore} from "../toolResults/index.js";
import {inlineToolResult} from "../tools/execute.js";
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
import {EMPTY_AGENT_INPUT_CHANNEL} from "../agent/inputChannel.js";
import {createForkDirective, createForkResultFiles} from "./fork.js";
import {type SubagentRegistration} from "./registration.js";
import {resolveSubagentModel} from "./model.js";
import {createFileStateTracker} from "../tools/shared/fileState.js";
import {resolveSubagentDirectory, subagentInstructions, subagentPermissionRules} from "./workspace.js";

interface SubagentRunnerDependencies {
    primaryRunAgent: AgentRunner;
    fastRunAgent: AgentRunner;
    fastModel: string;
    registry: SubagentRegistry;

    createToolResultStore(cwd: string, sessionId: string): ToolResultStore;
}

const DEFAULT_FINALIZE_PROMPT = [
    "工具执行阶段已经结束。",
    "现在禁止继续调用工具，请只根据当前 history 中已经获得的证据输出最终任务报告。",
    "报告应回答原始任务，列出已完成修改、验证结果和未完成部分，不得把未执行的检查声称为通过。",
].join("\n");

const READONLY_FORK_TOOLS = [
    "list_files",
    "glob",
    "read_file",
    "grep",
] as const;

const WRITABLE_FORK_TOOLS = [
    "list_files",
    "glob",
    "read_file",
    "grep",
    "edit_file",
    "write_file",
    "delete_file",
    "bash",
] as const;

function createForkRegistration(
    request: ForkSubagentRequest,
    parentContext: ToolContext
): SubagentRegistration {
    const allowedTools = request.readOnly !== true
        ? WRITABLE_FORK_TOOLS
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
        concurrencySafe: request.readOnly === true,
        createRuntimeConfig() {
            return {
                toolRuntimeOptions: {allowedToolNames: allowedTools},
                contextResources: {
                    readOnlyTools: request.readOnly === true,
                    toolNames: parentContext.toolNames,
                    storage: parentContext.storage,
                    cwd: parentContext.cwd,
                    workspaceBoundary:
                        parentContext.workspaceBoundary ?? parentContext.cwd,
                    skills: [],
                    instructions: parentContext.instructions,
                    shellRunner: parentContext.shellRunner,
                },
                permissionRules: {
                    allow: [],
                    ask: [],
                    deny: [...parentContext.permissionRules.deny],
                },
                permissionMode: "ask",
                collaborationMode: parentContext.collaborationMode,
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
        const writable = request.workspaceWriteApproved === true && request.readOnly !== true &&
            !parentContext.readOnlyTools && parentContext.collaborationMode !== "plan";
        runtimeConfig.contextResources.readOnlyTools = !writable;
        runtimeConfig.permissionRules = subagentPermissionRules(parentContext);
        const runtime = createToolRuntime({...runtimeConfig.toolRuntimeOptions,
            allowedToolNames: (runtimeConfig.toolRuntimeOptions.allowedToolNames ?? [])
                .filter(name => parentContext.toolNames.includes(name)),
        });
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
            : [];
        const childCompactState = createCompactState();
        const childContextUsage = new ContextUsageTracker();
        const childFileState = createFileStateTracker();
        const childToolResultStore = dependencies.createToolResultStore(
            options.storageCwd ?? parentContext.cwd,
            childSessionId
        );
        const childToolResultFiles = request.kind === "fork"
            ? createForkResultFiles(childHistory, parentContext.toolResultFiles, childToolResultStore)
            : undefined;

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
        let childCwd: string | undefined;
        let instructions = parentContext.instructions;

        const thread: SubagentThread = {
            agentId,
            async run(input) {
                if (running) {
                    throw new Error(`Agent Thread 正在运行: ${agentId}`);
                }
                running = true;
                let hookStart: Extract<HookInput, {hook_event_name: "SubagentStart"}> | undefined;
                let hookStatus: "completed" | "failed" | "cancelled" = "failed";
                let hookReason = "error";
                try {
                    throwIfTurnAborted(input.signal);
                    const cwd = await resolveSubagentDirectory(parentContext, request.cwd);
                    throwIfTurnAborted(input.signal);
                    if (childCwd !== undefined && cwd !== childCwd) throw new Error("子 Agent 工作目录在继续前发生变化");
                    if (childCwd === undefined) {
                        childCwd = cwd;
                        instructions = await subagentInstructions(parentContext, cwd);
                        if (request.kind !== "fork") childHistory.push({role: "system",
                            content: createAgentSystemPrompt(definition, cwd, childModel, initialToolNames)});
                    }
                    if (runCount === 0 && request.kind === "fork") {
                        const copied = new Set<string>();
                        for (const ref of childHistory.flatMap(message => imageReferences(message.content))) {
                            if (copied.has(ref.imageId)) continue;
                            if (!parentContext.imageAccess) throw new Error("父线程没有图片读取能力");
                            const data = await parentContext.imageAccess.read(ref);
                            const sourceData = await parentContext.imageAccess.readSource(ref);
                            await persistPreparedImage({store: childToolResultStore, origin: {kind: "tool", toolCallId: request.parentToolCallId, toolName: "agent"},
                                prepared: {data, image: ref.image}, sourceData, signal: parentContext.signal});
                            copied.add(ref.imageId);
                        }
                    }
                    const firstRun = runCount === 0;
                    runCount += 1;
                    const childContext: ToolContext = createToolContext({
                        signal: input.signal,
                        // 逐字段构造，禁止未来 capability 被 Root resources 自动扩散到 Child。
                        resources: {
                            ...runtimeConfig.contextResources,
                            cwd, workspaceBoundary: cwd, instructions, toolNames: runtime.toolNames,
                            fileCommits: parentContext.fileCommits,
                            // Child 只能凭自己实际读取过的内容获得编辑授权。
                            model: childModel,
                            provider: childProvider,
                            fastModel: dependencies.fastModel,
                            fastProvider: parentContext.fastProvider,
                            contextSettings: parentContext.contextSettings,
                        },
                        session: {
                            fileState: childFileState,
                            sessionId: childSessionId,
                            compactState: childCompactState,
                            contextUsage: childContextUsage,
                            toolResultStore: childToolResultStore,
                            toolResultFiles: childToolResultFiles,
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
                            setTodos() {
                            },
                        },
                    });
                    const executeChildTool: typeof runtime.executeTool = async (name, args, context, callId) => {
                        try {
                            const current = await resolveSubagentDirectory(parentContext, request.cwd);
                            if (current !== cwd) return inlineToolResult("子 Agent 工作目录在工具执行前发生变化，未执行", "denied");
                        } catch (error) {
                            return inlineToolResult(`子 Agent 目录权限拒绝: ${error instanceof Error ? error.message : String(error)}`, "denied");
                        }
                        return runtime.executeTool(name, args, context, callId);
                    };
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
                                cwd,
                                allowedTools: runtime.toolNames,
                            });
                            transcriptPath = transcript.path;
                            transcriptStarted = true;
                        } catch {
                            transcriptDisabled = true;
                        }
                    }

                    hookStart = {hook_event_name: "SubagentStart", session_id: parentContext.sessionId,
                        turn_id: parentContext.turnId, parent_turn_id: parentContext.turnId, agent_id: agentId,
                        agent_type: definition.agentType, run_count: runCount, child_cwd: childContext.cwd,
                        ...(input.taskId ? {task_id: input.taskId} : {})};
                    await parentContext.runHook?.(hookStart, input.signal);
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
                        if (transcriptPath && event.type !== "assistant_draft" && event.type !== "assistant_draft_end" &&
                            event.type !== "model_stream_start" && event.type !== "model_stream_progress" && event.type !== "model_stream_end") {
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
                    const totalBudget =
                        definition.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;
                    const explorationBudget = Math.max(1, totalBudget - 1);
                    const childPrompt = firstRun && request.kind === "fork"
                        ? createForkDirective({
                            name: request.name,
                            description: request.description,
                            prompt: `当前实际工作目录：${cwd}。路径以此目录为准，继承历史中的其他目录不授予访问权限。\n${input.prompt}`,
                            writable,
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
                            inputOrigin: "agent",
                            getToolSchemas: runtime.getToolSchemas,
                            isToolConcurrencySafe: runtime.isConcurrencySafe,
                            executeTool: executeChildTool,
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
                            DEFAULT_FINALIZE_PROMPT,
                            childHistory,
                            recordChildEvent,
                            childContext,
                            input.inputChannel,
                            {
                                maxIterations: 1,
                                inputOrigin: "agent",
                                getToolSchemas: () => [],
                                isToolConcurrencySafe: runtime.isConcurrencySafe,
                                executeTool: executeChildTool,
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
                        ...(subagentResult.transcriptPath
                            ? {transcriptPath: subagentResult.transcriptPath}
                            : {}),
                    });
                    hookReason = subagentResult.reason;
                    hookStatus = subagentResult.reason === "interrupted" ? "cancelled"
                        : subagentResult.reason === "completed" || subagentResult.reason === "no_tool_calls" ? "completed" : "failed";
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
                    try {
                        if (hookStart) await parentContext.runHook?.({...hookStart, hook_event_name: "SubagentStop",
                            status: input.signal.aborted ? "cancelled" : hookStatus,
                            reason: input.signal.aborted ? "cancelled" : hookReason}, input.signal);
                    } finally {running = false;}
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
