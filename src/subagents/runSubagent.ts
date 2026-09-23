import {createSessionPersistence} from "../session/storage.js";
import {createSessionArchiveAccess, prepareSessionArchive} from "../session/archive.js";
import {childTaskTool} from "../tools/task/task.js";
import {createToolCatalog} from "../tools/catalog.js";
import {createChildTaskAccess} from "../tasks/childAccess.js";
import {CUSTOM_AGENT_FORBIDDEN_TOOLS} from "./registration.js";
import {ensureSessionIdentity} from "../persistence/projectState.js";
import {finishPromptLogRun} from "../llm/promptLog.js";
import type {LLMTrace} from "../llm/types.js";
import {throwIfTurnAborted} from "../runtime/abort.js";
import {ContextUsageTracker} from "../context/usage.js";
import {persistPreparedImage} from "../images/persist.js";
import {imageReferences} from "../images/content.js";
import type {HookInput} from "../hooks/types.js";
import {randomUUID} from "node:crypto";
import type {Todo} from "../todos.js";
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
    SubagentRequest,
    SubagentResult,
    SubagentThread,
} from "./types.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../agent/inputChannel.js";
import {createForkDirective, createForkResultFiles} from "./fork.js";
import {usesFastSubagentModel} from "./model.js";
import {createFileStateTracker} from "../tools/shared/fileState.js";
import {resolveSubagentDirectory, subagentInstructions, subagentPermissionRules} from "./workspace.js";

interface SubagentRunnerDependencies {
    primaryRunAgent: AgentRunner;
    fastRunAgent: AgentRunner;
    registry: SubagentRegistry;

    createToolResultStore(cwd: string, sessionId: string): ToolResultStore;
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
        const registration = dependencies.registry.get(request.agentType);
        if (!registration) {
            const available = dependencies.registry
                .listDefinitions()
                .map((definition) => definition.agentType)
                .join(", ");
            throw new Error(
                `Unknown Agent type: ${request.agentType}. Currently available: ${available}`
            );
        }
        const {definition} = registration;
        const writable = request.workspaceWriteApproved === true && request.readOnly !== true && !definition.readOnly &&
            !parentContext.readOnlyTools && parentContext.collaborationMode !== "plan";
        const permissionRules = subagentPermissionRules(parentContext);
        const collaborationMode = parentContext.collaborationMode;
        const canMessageParent = options.agentMessaging !== undefined && parentContext.toolNames.includes("agent_message");
        const tools = parentContext.availableTools.filter(tool =>
            parentContext.toolNames.includes(tool.name) && !CUSTOM_AGENT_FORBIDDEN_TOOLS.has(tool.name) &&
            (definition.allowedTools === undefined || definition.allowedTools.includes(tool.name) || (tool.name === "agent_message" && canMessageParent)) &&
            (tool.name !== "agent_message" || canMessageParent) &&
            (tool.name !== "task" || parentContext.tasks !== undefined) &&
            (tool.name !== "skill" || parentContext.skills.length > 0))
            .map(tool => tool.name === "task" ? childTaskTool(tool) : tool);
        const builtinNames = new Set(createToolCatalog({}).tools.map(tool => tool.name));
        const runtime = createToolRuntime({
            allowedToolNames: tools.map(tool => tool.name),
            toolOverrides: tools.filter(tool => builtinNames.has(tool.name)),
            additionalTools: tools.filter(tool => !builtinNames.has(tool.name)),
        });
        const childSkills = definition.source === "builtin" && definition.agentType === "Explore" ? [] : structuredClone(parentContext.skills);
        const childTasks = parentContext.tasks ? createChildTaskAccess(parentContext.tasks, parentContext.toolResultFiles) : undefined;
        const initialToolNames = runtime.getToolSchemas()
            .map((tool) => tool.function.name);
        const useFastModel = usesFastSubagentModel(definition);
        const childModel = useFastModel ? parentContext.fastModel : parentContext.model;
        const runChildAgent = useFastModel ? dependencies.fastRunAgent : dependencies.primaryRunAgent;
        const childProvider = useFastModel ? parentContext.fastProvider : parentContext.provider;
        const childSessionId = `subagent-${agentId}`;
        const childHistory: Message[] = request.contextSnapshot !== undefined
            ? structuredClone(request.contextSnapshot.history)
            : [];
        const childCompactState = createCompactState();
        const storageCwd = options.storageCwd ?? parentContext.cwd;
        const persistence = createSessionPersistence(parentContext.storage, storageCwd, childSessionId, "internal");
        const inheritedState = request.contextSnapshot ? structuredClone(parentContext.compactState) : undefined;
        const inheritedArchives = inheritedState ? createSessionArchiveAccess(parentContext.storage, storageCwd,
            parentContext.sessionId, () => inheritedState) : undefined;
        const archiveAccess = createSessionArchiveAccess(parentContext.storage, storageCwd, childSessionId,
            () => childCompactState, inheritedArchives);
        const childContextUsage = new ContextUsageTracker();
        const childFileState = createFileStateTracker();
        const childToolResultStore = dependencies.createToolResultStore(
            options.storageCwd ?? parentContext.cwd,
            childSessionId
        );
        const childToolResultFiles = request.contextSnapshot !== undefined
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
        let transcriptIssue: string | undefined;
        let childTodos: Todo[] = [];
        let running = false;
        let runCount = 0;
        let childCwd: string | undefined;
        let instructions = parentContext.instructions;

        const thread: SubagentThread = {
            agentId,
            async run(input) {
                if (running) {
                    throw new Error(`Agent Thread is running: ${agentId}`);
                }
                running = true;
                let logTrace: LLMTrace | undefined;
                let hookStart: Extract<HookInput, {hook_event_name: "SubagentStart"}> | undefined;
                let hookStatus: "completed" | "failed" | "cancelled" = "failed";
                let hookReason = "error";
                try {
                    throwIfTurnAborted(input.signal);
                    const cwd = await resolveSubagentDirectory(parentContext, request.cwd);
                    throwIfTurnAborted(input.signal);
                    if (childCwd !== undefined && cwd !== childCwd) throw new Error("Child Agent working directory changed before continuation");
                    if (childCwd === undefined) {
                        childCwd = cwd;
                        instructions = await subagentInstructions(parentContext, cwd);
                        const workerSystem: Message = {role: "system",
                            content: createAgentSystemPrompt(definition, cwd, childModel, initialToolNames)};
                        if (request.contextSnapshot !== undefined) {
                            if (childHistory[0]?.role !== "system") throw new Error("Fork History is missing a system message");
                            childHistory[0] = workerSystem;
                        } else childHistory.push(workerSystem);
                    }
                    if (runCount === 0 && request.contextSnapshot !== undefined) {
                        const copied = new Set<string>();
                        for (const ref of childHistory.flatMap(message => imageReferences(message.content))) {
                            if (copied.has(ref.imageId)) continue;
                            if (!parentContext.imageAccess) throw new Error("Parent thread has no image-read capability");
                            const data = await parentContext.imageAccess.read(ref);
                            const sourceData = await parentContext.imageAccess.readSource(ref);
                            await persistPreparedImage({store: childToolResultStore, origin: {kind: "tool", toolCallId: request.parentToolCallId, toolName: "agent"},
                                prepared: {data, image: ref.image}, sourceData, signal: parentContext.signal});
                            copied.add(ref.imageId);
                        }
                    }
                    try {await ensureSessionIdentity(parentContext.storage, options.storageCwd ?? parentContext.cwd, childSessionId);}
                    catch {transcriptIssue = "Subagent storage identity could not be recorded; task execution continues.";}
                    const firstRun = runCount === 0;
                    runCount += 1;
                    if (childTodos.every(todo => todo.status === "completed")) childTodos = [];
                    let todosUpdatedThisRun = false;
                    const childContext: ToolContext = createToolContext({
                        signal: input.signal,
                        // Construct fields explicitly so future Root capabilities cannot leak into children automatically.
                        resources: {
                            storage: parentContext.storage, shellRunner: parentContext.shellRunner, readOnlyTools: !writable,
                            cwd, workspaceBoundary: cwd, instructions, toolNames: runtime.toolNames, availableTools: runtime.getTools(),
                            skills: childSkills,
                            tasks: childTasks?.tasks,
                            fileCommits: parentContext.fileCommits,
                            agentMessaging: canMessageParent ? options.agentMessaging : undefined,
                            // Children gain edit authority only from their own actual reads.
                            model: childModel,
                            provider: childProvider,
                            fastModel: parentContext.fastModel,
                            fastProvider: parentContext.fastProvider,
                            contextSettings: parentContext.contextSettings,
                        },
                        session: {
                            fileState: childFileState,
                            sessionId: childSessionId,
                            compactState: childCompactState,
                            contextUsage: childContextUsage,
                            toolResultStore: childToolResultStore,
                            toolResultFiles: {resolveFile: async path => await (childToolResultFiles ?? childToolResultStore).resolveFile(path) ?? await childTasks?.files.resolveFile(path) ?? null},
                        },
                        host: {
                            canUseTool: async () => ({
                                behavior: "deny",
                                message: "Child Agents cannot request interactive permission approval",
                            }),
                            getPermissionRules: () => permissionRules,
                            getPermissionMode: () => "ask",
                            getCollaborationMode: () => collaborationMode,
                            getPermissionPromptPolicy: () =>
                                "never",
                            async setTodos(todos) {
                                todosUpdatedThisRun = true;
                                childTodos = structuredClone(todos);
                                await recordChildEvent({type: "subagent_progress", agentId,
                                    event: {type: "todos", todos: structuredClone(childTodos)}});
                            },
                        },
                    });
                    const snapshot = (history = childHistory, compactState = childCompactState) => ({
                        cwd: storageCwd, sessionId: childSessionId, model: childModel, history, compactState,
                        todos: childTodos, permissionMode: "ask" as const, collaborationMode, allowEmpty: true,
                        toolDiscovery: runtime.getToolDiscoverySnapshot(),
                    });
                    childContext.sessionArchives = archiveAccess;
                    childContext.sessionCompaction = {
                        prepare: history => prepareSessionArchive(parentContext.storage, storageCwd, childSessionId, history),
                        commit: (history, state, draft) => persistence.compact(snapshot(history, state), draft, input.signal),
                    };
                    childContext.commitToolBatch = () => persistence.save(snapshot());
                    const executeChildTool: typeof runtime.executeTool = async (name, args, context, callId) => {
                        try {
                            const current = await resolveSubagentDirectory(parentContext, request.cwd);
                            if (current !== cwd) return inlineToolResult("Child Agent working directory changed before tool execution; tool was not executed", "denied");
                        } catch (error) {
                            return inlineToolResult(`Child Agent directory permission denied: ${error instanceof Error ? error.message : String(error)}`, "denied");
                        }
                        return runtime.executeTool(name, args, context, callId);
                    };
                    logTrace = {scope: "session", ownerCwd: options.storageCwd ?? parentContext.cwd,
                        sessionId: parentContext.llmTrace?.scope === "session" ? parentContext.llmTrace.sessionId : parentContext.sessionId,
                        runId: childContext.turnId, agentId};
                    childContext.llmTrace = logTrace;
                    // Omitting subagentLauncher enforces the no-recursion boundary.
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
                                ...(request.name ? {agentName: request.name} : {}),
                                description: request.description,
                                model: childModel,
                                cwd,
                                allowedTools: runtime.toolNames,
                            });
                            transcriptPath = transcript.path;
                            transcriptStarted = true;
                        } catch {
                            transcriptDisabled = true;
                            transcriptIssue = "Subagent transcript is incomplete or unavailable; task execution continues.";
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
                        ...(request.name ? {agentName: request.name} : {}),
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
                            transcriptIssue = "Subagent transcript is incomplete or unavailable; task execution continues.";
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
                        if (event.type === "subagent_progress") await emit(onEvent, event);
                        await onChildEvent?.(event);
                    };
                    const childPrompt = firstRun && request.contextSnapshot !== undefined
                        ? createForkDirective({
                            name: request.name ?? definition.agentType,
                            description: request.description,
                            prompt: `Current working directory: ${cwd}. Resolve paths relative to this directory; other directories in inherited history do not grant access.\n ${input.prompt}`,
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
                            getTodos: () => childTodos,
                            getAdditionalUserContextBlocks: async () => [
                                `Worker run ${runCount}${firstRun ? "" : ": continuation with existing History, FileState and cwd"}. ` +
                                `Todo updated this run: ${todosUpdatedThisRun ? "yes" : "no"}. ` +
                                (childTodos.length && !todosUpdatedThisRun ? "The unfinished plan is carried forward; continue or revise it honestly. " : "") +
                                "For multi-step work, use todo_write for this assignment and update it at phase changes. A prior completed plan does not track new work. Do not claim progress updates without calling the tool. Trivial follow-ups need no plan.",
                            ],
                            inputOrigin: "assignment",
                            getToolSchemas: runtime.getToolSchemas,
                            isToolConcurrencySafe: runtime.isConcurrencySafe,
                            executeTool: executeChildTool,
                        }
                    );
                    try { await persistence.save(snapshot()); }
                    catch { transcriptIssue = "Subagent snapshot could not be saved; the report is available only in this process."; }
                    if ((result.reason === "completed" || result.reason === "no_tool_calls") &&
                        childTodos.some(todo => todo.status !== "completed")) {
                        result = {...result, reason: "incomplete",
                            reply: `${result.reply}\n\nUnfinished child tasks:\n${childTodos.filter(todo => todo.status !== "completed").map(todo => `- ${todo.content}`).join("\n")}`};
                    }
                    const subagentResult: SubagentResult = {
                        agentId,
                        agentType: definition.agentType,
                        ...(request.name ? {agentName: request.name} : {}),
                        description: request.description,
                        reply: result.reply,
                        reason: result.reason,
                        iterations: result.iterations,
                        toolUseCount,
                        durationMs: Date.now() - startedAt,
                        ...(transcriptPath ? {transcriptPath} : {}),
                        ...(transcriptIssue ? {transcriptIssue} : {}),
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
                            transcriptIssue = "Subagent transcript is incomplete or unavailable; task execution continues.";
                            delete subagentResult.transcriptPath;
                            subagentResult.transcriptIssue = transcriptIssue;
                        }
                    }

                    await emit(onEvent, {
                        type: "subagent_end",
                        agentId,
                        agentType: definition.agentType,
                        ...(request.name ? {agentName: request.name} : {}),
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
                            // Preserve the original execution error.
                        }
                    }
                    await emit(onEvent, {
                        type: "subagent_error",
                        agentId,
                        agentType: definition.agentType,
                        ...(request.name ? {agentName: request.name} : {}),
                        message,
                    });
                    throw error;
                } finally {
                    try {
                        if (hookStart) await parentContext.runHook?.({...hookStart, hook_event_name: "SubagentStop",
                            status: input.signal.aborted ? "cancelled" : hookStatus,
                            reason: input.signal.aborted ? "cancelled" : hookReason}, input.signal);
                    } finally {if (logTrace) finishPromptLogRun(parentContext.storage, logTrace); running = false;}
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
