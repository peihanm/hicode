import {toolCallTarget} from "../tools/mcp/call.js";
import {TaskReviewProgress} from "./taskReview.js";
import {contentText, type MessageContent} from "../images/content.js";
import {createImageAccess} from "../images/access.js";
import {HookControlError} from "../hooks/index.js";
import {ResponseDraft} from "./draft.js";
import type {ToolContext} from "../tools/types.js";
import type {LLMCaller, LLMCallKind, Message, ToolCall} from "../llm/types.js";
import {hasCompleteToolPairs} from "../session/store/codec.js";
import {formatInterruptedToolResult} from "../tools/registry.js";
import {getContextBudget, getTokenWarningState} from "../context/index.js";
import {isTurnInterruptedError, normalizeTurnAbortReason, throwIfTurnAborted,} from "../runtime/abort.js";
import type {AgentEvent, AgentResult} from "./types.js";
import {executeToolCallBatch, type ToolExecutor,} from "./toolBatch.js";
import {inlineToolResult} from "../tools/execute.js";
import {type CompactHistoryRunner, prepareAgentInvoke, type ToolSchemaProvider,} from "./invokePreparation.js";
import {createTurnCompletion} from "./turnCompletion.js";
import type {AgentInputChannel, QueuedAgentInput} from "./inputChannel.js";
import type {Todo} from "../session/todo.js";
import {TodoProgress} from "./todoProgress.js";
import {ContextLengthError} from "../llm/errors.js";

export interface AgentToolBindings {
    getToolSchemas: ToolSchemaProvider;
    executeTool: ToolExecutor;
    isToolConcurrencySafe: (name: string, argsJson: string) => boolean;
}

export interface AgentRunOptions extends AgentToolBindings {
    inputOrigin?: "user" | "assignment";
    callKind?: LLMCallKind;
    maxIterations?: number;
    /** Read Host-owned Todo truth for progress reminders and completion checks. */
    getTodos?: () => readonly Todo[];
    /** Stop the tool stage after this many consecutive permission denials, for non-interactive child runtimes. */
    maxConsecutiveDeniedToolCalls?: number;
    /** Host context for this Turn; not persisted in History. */
    additionalUserContextBlocks?: readonly string[];
    getAdditionalUserContextBlocks?: () => Promise<readonly string[]>;
}

interface AgentRunnerDependencies {
    callLLM: LLMCaller;
    compactHistory: CompactHistoryRunner;
}

export function createAgentRunner(
    dependencies: AgentRunnerDependencies
): AgentRunner {
    return (
        userInput: MessageContent,
        history: Message[],
        onEvent: (event: AgentEvent) => void | Promise<void>,
        ctx: ToolContext,
        inputChannel: AgentInputChannel,
        options: AgentRunOptions
    ) => runAgentCore(
        userInput,
        history,
        onEvent,
        ctx,
        inputChannel,
        options,
        dependencies
    );
}

export type AgentRunner = (
    userInput: MessageContent,
    history: Message[],
    onEvent: (event: AgentEvent) => void | Promise<void>,
    ctx: ToolContext,
    inputChannel: AgentInputChannel,
    options: AgentRunOptions
) => Promise<AgentResult>;

function assertFreshToolCallIds(
    history: readonly Message[],
    toolCalls: readonly {id: string}[]
): void {
    if (toolCalls.length === 0) return;
    const existing = new Set<string>();
    for (const message of history) {
        if (message.role === "tool") existing.add(message.tool_call_id);
        if (message.role === "assistant") {
            for (const call of message.tool_calls ?? []) existing.add(call.id);
        }
    }
    const duplicate = toolCalls.find((call) => existing.has(call.id));
    if (duplicate) {
        throw new Error(`Model reused a historical Tool Call ID: ${duplicate.id}`);
    }
}

function assertCompleteToolPairs(history: readonly Message[]): void {
    if (!hasCompleteToolPairs(history)) throw new Error("History contains incomplete Tool Call pairs; model request stopped");
}

// Agent loop: call LLM, execute tools, feed results back, repeat until a final answer.
//
// onEvent streams progress to the UI instead of console.log; the UI decides rendering.
// ctx injects confirmation and other dependencies so tools do not couple to readline/Ink.

async function runAgentCore(
    userInput: MessageContent,
    history: Message[],
    emitEvent: (event: AgentEvent) => void | Promise<void>,
    ctx: ToolContext,
    inputChannel: AgentInputChannel,
    options: AgentRunOptions,
    dependencies: AgentRunnerDependencies
): Promise<AgentResult> {
    const taskStartedAt = performance.now();
    assertCompleteToolPairs(history);
    const maxIterations = options.maxIterations === undefined
        ? undefined
        : Math.max(1, Math.floor(options.maxIterations));
    ctx.imageAccess = createImageAccess({storage: ctx.storage, store: ctx.toolResultStore, history: () => history, state: () => ctx.compactState});
    const callLLMImpl = dependencies.callLLM;
    const getToolSchemasImpl = options.getToolSchemas;
    const executeToolImpl = options.executeTool;
    const isToolConcurrencySafeImpl = options.isToolConcurrencySafe;
    const compactHistoryImpl = dependencies.compactHistory;
    const turnId = ctx.turnId;
    const draft = new ResponseDraft(emitEvent);
    let iterations = 0;
    const taskReview = new TaskReviewProgress(ctx, history);
    const onEvent = async (event: AgentEvent): Promise<void> => {
        if (event.type === "assistant_text") {
            const responseId = await draft.finish("committed");
            await emitEvent({...event, ...(responseId ? {responseId} : {})});
        } else await emitEvent(event);
    };
    const maxConsecutiveDeniedToolCalls =
        options.maxConsecutiveDeniedToolCalls === undefined
            ? undefined
            : Math.max(1, Math.floor(options.maxConsecutiveDeniedToolCalls));
    const todoProgress = new TodoProgress();
    let completionNudge: string | undefined;
    let consecutiveDeniedToolCalls = 0;
    let usageInputTokens = 0;
    let usageOutputTokens = 0;
    let usageTotalTokens = 0;
    let usageCalls = 0;
    let usageEstimated = false;
    let contextLengthRecoveryUsed = false;
    let forceCompact = false;
    const contextBudget = getContextBudget(ctx.contextSettings);

    let pendingToolCalls: readonly ToolCall[] = [];
    const resultUsage = () => usageCalls === 0
        ? {}
        : {
            usage: {
                inputTokens: usageInputTokens,
                ...(!usageEstimated
                    ? {
                        outputTokens: usageOutputTokens,
                        totalTokens: usageTotalTokens,
                    }
                    : {}),
                estimated: usageEstimated,
            },
        };
    const interruptedResult = async (): Promise<AgentResult> => {
        const abortReason = normalizeTurnAbortReason(ctx.signal.reason);
        await onEvent({type: "turn_interrupted", reason: abortReason});
        return {
            reply: "(Task cancelled)",
            reason: "interrupted",
            iterations,
            abortReason,
            ...resultUsage(),
        };
    };

    const appendQueuedInputs = async (inputs: readonly QueuedAgentInput[]) => {
        const accepted = inputs.filter(input => !ctx.taskJoin || ctx.taskJoin.accepts(input));
        for (const input of accepted) {
            if (input.source === "user_input" || input.source === "user_answer") taskReview.steer();
            history.push({role: "user", origin: input.source === "runtime_message" ? "runtime" : (input.source === "user_input" || input.source === "user_answer") ? "user" : input.source === "agent_message" ? (options.inputOrigin === "assignment" ? "assignment" : "agent") : "task_notification", content: input.content});
        }
        for (const input of accepted) {
            await ctx.taskJoin?.consume(input);
            if (input.source === "agent_message") await onEvent({type: "coordination_message", messageId: input.id, text: contentText(input.content)});
        }
    };

    const completeTurn = createTurnCompletion({history, ctx, inputChannel, draft, onEvent, appendQueuedInputs,
        getTodos: () => options.getTodos?.() ?? []});

    // Completed-task notifications precede new questions as transient runtime messages, not separate LLM turns.
    const initialDelivery = appendQueuedInputs(inputChannel.drainInitial());
    // Append real user input to History; userContext stays transient.
    history.push({role: "user", origin: options.inputOrigin ?? "user", content: userInput});

    try {
        await initialDelivery;
        throwIfTurnAborted(ctx.signal);
        for (
            let i = 0;
            maxIterations === undefined || i < maxIterations;
            i++
        ) {
            iterations = i + 1;
            if (i > 0) taskReview.completedRound(i, history);
            // Capture terminal delegates even for headless Hosts without a UI notification pump.
            const completedDelegates = await ctx.taskJoin?.collect() ?? [];
            await appendQueuedInputs(completedDelegates);
            if (completedDelegates.length) await ctx.commitToolBatch?.();
            await onEvent({
                type: "iteration",
                current: i + 1,
                ...(maxIterations === undefined ? {} : {max: maxIterations}),
            });
            const hasNextIteration =
                maxIterations === undefined || i + 1 < maxIterations;
            await draft.finish("discarded");
            const toolSchemas = getToolSchemasImpl();
            const todoReminder = todoProgress.takeReminder(
                options.getTodos?.() ?? [],
                toolSchemas.some(tool => tool.function.name === "todo_write")
            );
            const {invokeMessages, tools, estimatedTokens} = await prepareAgentInvoke({
                history,
                ctx,
                onEvent,
                getToolSchemas: () => toolSchemas,
                compactHistory: compactHistoryImpl,
                forceCompact,
                elapsedTaskStartedAt: iterations % 4 === 0 ? taskStartedAt : undefined,
                taskReviewReminder: taskReview.takeReminder(),
                getTodos: options.getTodos,
                getAdditionalUserContextBlocks:options.getAdditionalUserContextBlocks,
                additionalUserContextBlocks: [
                    ...(options.additionalUserContextBlocks ?? []),
                    ...(todoReminder ? [todoReminder] : []),
                    ...(completionNudge ? [completionNudge] : []),
                ],
            });
            forceCompact = false;
            completionNudge = undefined;
            // This request's exposure is immutable even if the catalog changes during the batch.
            const offeredToolNames = new Set(tools.map(tool => tool.function.name));

            // Call the LLM with invokeMessages, not raw History.
            assertCompleteToolPairs(invokeMessages);
            await onEvent({type: "model_stream_start"});
            let llmResult;
            try {
                llmResult = await callLLMImpl({
                    messages: invokeMessages,
                    tools,
                    storage: ctx.storage,
                    cwd: ctx.cwd,
                    model: ctx.model,
                    kind: options.callKind ?? "main",
                    signal: ctx.signal,
                    onStreamProgress: progress => {
                        void onEvent({
                            type: "model_stream_progress",
                            ...progress,
                        });
                    },
                    onText: draft.update,
                    readImage: reference => ctx.imageAccess!.read(reference),
                    trace: ctx.llmTrace ?? {scope: "session", ownerCwd: ctx.cwd, sessionId: ctx.sessionId, runId: ctx.turnId},
                    reasoning: ctx.reasoning,
                });
            } catch (error) {
                if (error instanceof ContextLengthError && !ctx.signal.aborted && !contextLengthRecoveryUsed && hasNextIteration && ctx.sessionCompaction) {
                    contextLengthRecoveryUsed = true;
                    forceCompact = true;
                    ctx.contextUsage.reset();
                    continue;
                }
                throw error;
            } finally {
                await onEvent({type: "model_stream_end"});
            }
            const {message, usage, contextUsage} = llmResult;
            const toolCalls = message.tool_calls ?? [];
            throwIfTurnAborted(ctx.signal);
            const textContent = typeof message.content === "string" && message.content.trim() ? message.content : "";
            if (!textContent && toolCalls.length === 0) {
                throw new Error("LLM caller returned an empty assistant response; response validation and retries belong to the LLM layer");
            }
            ctx.fileState.commitVisible(invokeMessages);
            assertFreshToolCallIds(history, toolCalls);
            history.push(message);
            pendingToolCalls = toolCalls;

            // OpenAI-compatible gateways may omit streaming usage. prompt_tokens=0 cannot be valid
            // for a nonempty request; retain the preparation estimate rather than
            // presenting missing usage as an actual zero-token measurement.
            const hasActualUsage =
                Number.isFinite(usage.prompt_tokens) && usage.prompt_tokens > 0;
            const contextTokenCount = contextUsage?.tokenCount;
            const hasActualContextUsage = contextTokenCount !== undefined &&
                Number.isFinite(contextTokenCount) &&
                contextTokenCount > 0;
            const tokenCount = hasActualContextUsage
                ? contextTokenCount
                : hasActualUsage
                    ? usage.prompt_tokens
                    : estimatedTokens;
            ctx.contextUsage.record({model: ctx.model, provider: ctx.provider, compactCount: ctx.compactState.compactCount},
                invokeMessages, tools, contextUsage?.inputTokens ?? (hasActualUsage ? usage.prompt_tokens : undefined));
            usageCalls += 1;
            if (hasActualUsage) {
                usageInputTokens += usage.prompt_tokens;
                usageOutputTokens += usage.completion_tokens;
                usageTotalTokens += usage.total_tokens;
            } else {
                usageInputTokens += tokenCount;
                usageEstimated = true;
            }
            const postState = getTokenWarningState(tokenCount, contextBudget);
            await onEvent({
                type: "token_update",
                tokenCount,
                percentUsed: postState.percentUsed,
                warning: postState.warning,
                status: hasActualContextUsage || hasActualUsage
                    ? "actual"
                    : "estimated",
            });

            if (toolCalls.length === 0) {
                const decision = await completeTurn(textContent, hasNextIteration);
                if (decision.action === "limit") break;
                if (decision.action === "continue") {
                    completionNudge = decision.reminder;
                    continue;
                }
                const reply = decision.reason === "completed" && postState.critical
                    ? `${decision.reply}\n\n⚠️ Context usage is ${Math.round(postState.percentUsed * 100)}%; consider starting a new session after this turn.`
                    : decision.reply;
                return {reply, reason: decision.reason, iterations, ...resultUsage()};
            }

            // OpenAI-compatible providers may return user-facing text together
            // with tool calls. It is mid-turn commentary, not a final answer:
            // publish it before the matching tools instead of silently keeping
            // it only in History (which made it appear only after /resume).
            if (textContent) {
                await onEvent({
                    type: "assistant_text",
                    content: textContent,
                    phase: "commentary",
                });
            }

            const batchResult = await executeToolCallBatch({
                toolCalls,
                history,
                ctx,
                turnId,
                onEvent,
                executeTool: (name, args, context, callId) => offeredToolNames.has(name)
                    ? executeToolImpl(name, args, context, callId)
                    : Promise.resolve(inlineToolResult(
                        "Tool " + name + " was not provided in this model request and was not executed. Use only the tools provided in this request. For MCP tools, look up the current definition with tool_search and invoke it using mcp_call. If the server is unavailable, report the blocker.",
                        "denied",
                    )),
                isToolConcurrencySafe: (name, args) => offeredToolNames.has(name) && isToolConcurrencySafeImpl(name, args),
            });
            pendingToolCalls = [];
            await ctx.commitToolBatch?.();
            if (batchResult.status === "interrupted" || ctx.signal.aborted) {
                return interruptedResult();
            }
            todoProgress.recordToolBatch(batchResult.outcomes, options.getTodos?.() ?? []);
            let denialLimitReached = false;
            for (const outcome of batchResult.outcomes) {
                if (outcome.outcome === "denied") {
                    consecutiveDeniedToolCalls += 1;
                    if (
                        maxConsecutiveDeniedToolCalls !== undefined &&
                        consecutiveDeniedToolCalls >= maxConsecutiveDeniedToolCalls
                    ) {
                        denialLimitReached = true;
                    }
                } else {
                    consecutiveDeniedToolCalls = 0;
                }
            }
            if (ctx.approvalBudget.stopped) {
                return {reply: ctx.approvalBudget.stopMessage, reason: "permission_denied", iterations: i + 1, ...resultUsage()};
            }
            if (denialLimitReached) {
                return {
                    reply: `(After ${maxConsecutiveDeniedToolCalls} consecutive tool calls were denied by permission policy, the tool stage stopped)`,
                    reason: "permission_denied",
                    iterations: i + 1,
                    ...resultUsage(),
                };
            }
            if (hasNextIteration) {
                await appendQueuedInputs(inputChannel.drainSafeBoundary().filter(input => !ctx.taskJoin || ctx.taskJoin.accepts(input)));
            }
        }

        if (maxIterations === undefined) {
            throw new Error("Agent loop without an iteration limit exited unexpectedly");
        }
        const reply = `(Maximum iterations reached: ${maxIterations}; stopped)`;
        await onEvent({type: "assistant_text", content: reply, phase: "final"});
        return {
            reply,
            reason: "max_turns",
            iterations: maxIterations,
            ...resultUsage(),
        };
    } catch (error) {
        // The runner owns the gap between committing the assistant and entering the batch.
        const unpaired = pendingToolCalls.filter(call => !history.some(message => message.role === "tool" && message.tool_call_id === call.id));
        const outcome = isTurnInterruptedError(error, ctx.signal) ? "interrupted" as const : "failed" as const;
        const content = outcome === "interrupted" ? formatInterruptedToolResult(ctx.signal)
            : `Tool was not executed because the turn failed: ${error instanceof Error ? error.message : String(error)}`;
        for (const call of unpaired) history.push({role: "tool", content, tool_call_id: call.id});
        for (const call of unpaired) {
            const target = toolCallTarget(call.function.name, call.function.arguments);
            for (const event of [
                {type: "tool_call_start" as const, turnId, toolCallId: call.id, name: target.name, args: target.argsJson},
                {type: "tool_call_end" as const, turnId, toolCallId: call.id, result: content, outcome},
            ]) {
                try {await onEvent(event);} catch { /* Keep the original failure after closing History. */ }
            }
        }
        if (isTurnInterruptedError(error, ctx.signal)) {
            return interruptedResult();
        }
        if (error instanceof HookControlError) {
            const reply = `Hook check failed; this turn stopped: ${error.message}`;
            await onEvent({type: "assistant_text", content: reply, phase: "final"});
            return {reply, reason: "hook_error", iterations, ...resultUsage()};
        }
        throw error;
    } finally {
        taskReview.close();
        await draft.finish("discarded");
    }
}
