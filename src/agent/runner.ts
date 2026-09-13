import {contentText, type MessageContent} from "../images/content.js";
import {createImageAccess} from "../images/access.js";
import {HookControlError, formatHookContext} from "../hooks/index.js";
import {ResponseDraft} from "./draft.js";
import type {ToolContext} from "../tools/types.js";
import type {LLMCaller, Message} from "../llm/types.js";
import {getTokenWarningState} from "../context/index.js";
import {isTurnInterruptedError, normalizeTurnAbortReason, throwIfTurnAborted,} from "../runtime/abort.js";
import type {AgentEvent, AgentResult} from "./types.js";
import {executeToolCallBatch, type ToolExecutor,} from "./toolBatch.js";
import {inlineToolResult} from "../tools/execute.js";
import {type CompactHistoryRunner, prepareAgentInvoke, type ToolSchemaProvider,} from "./invokePreparation.js";
import {
    formatTodoCompletionReminder,
} from "./turnCompletion.js";
import type {AgentInputChannel, QueuedAgentInput} from "./inputChannel.js";
import type {Todo} from "../todos.js";
import {TodoProgress} from "./todoProgress.js";
import {ContextLengthError} from "../llm/errors.js";

export interface AgentToolBindings {
    getToolSchemas: ToolSchemaProvider;
    executeTool: ToolExecutor;
    isToolConcurrencySafe: (name: string, argsJson: string) => boolean;
}

export interface AgentRunOptions extends AgentToolBindings {
    inputOrigin?: "user" | "agent";
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

// Agent loop: call LLM, execute tools, feed results back, repeat until a final answer.
// needsFollowUp continues after tool calls and stops otherwise, following Claude Code query.ts.
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
    let completionGateUsed = false;
    let hookContinuationUsed = false;
    let completionNudge: string | undefined;
    let emptyResponseRetryUsed = false;
    let consecutiveDeniedToolCalls = 0;
    let usageInputTokens = 0;
    let usageOutputTokens = 0;
    let usageTotalTokens = 0;
    let usageCalls = 0;
    let usageEstimated = false;
    let contextLengthRecoveryUsed = false;
    let forceCompact = false;
    let providerContextWindow = ctx.contextUsage.contextWindow({model: ctx.model, provider: ctx.provider, compactCount: ctx.compactState.compactCount});

    let iterations = 0;
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
        for (const input of inputs) {
            history.push({role: "user", origin: input.source === "user_input" ? "user" : input.source === "agent_message" ? "agent" : "task_notification", content: input.content});
        }
        for (const input of inputs) {
            if (input.source === "agent_message") await onEvent({type: "coordination_message", messageId: input.id, text: contentText(input.content)});
        }
    };

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
                contextWindow: providerContextWindow,
                forceCompact,
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
            // This request's exposure is immutable even if discovery changes during the batch.
            const offeredToolNames = new Set(tools.map(tool => tool.function.name));

            // Call the LLM with invokeMessages, not raw History.
            await onEvent({type: "model_stream_start"});
            let llmResult;
            try {
                llmResult = await callLLMImpl(
                    invokeMessages,
                    tools,
                    ctx.storage,
                    ctx.cwd,
                    ctx.model,
                    "main",
                    ctx.signal,
                    progress => {
                        void onEvent({
                            type: "model_stream_progress",
                            ...progress,
                        });
                    },
                    draft.update,
                    reference => ctx.imageAccess!.read(reference),
                    ctx.llmTrace ?? {scope: "session", ownerCwd: ctx.cwd, sessionId: ctx.sessionId, runId: ctx.turnId}
                );
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
            const {message, toolCalls, usage, contextUsage} = llmResult;
            throwIfTurnAborted(ctx.signal);
            ctx.fileState.commitVisible(invokeMessages);
            assertFreshToolCallIds(history, toolCalls);
            // Append assistant messages and tool results as actual conversation content.
            history.push(message);
            const rawTextContent =
                typeof message.content === "string" ? message.content : "";
            const textContent = rawTextContent.trim().length > 0
                ? rawTextContent
                : "";

            // OpenAI-compatible gateways may omit streaming usage. prompt_tokens=0 cannot be valid
            // for a nonempty request; retain the preparation estimate rather than
            // presenting missing usage as an actual zero-token measurement.
            const hasActualUsage =
                Number.isFinite(usage.prompt_tokens) && usage.prompt_tokens > 0;
            const contextTokenCount = contextUsage?.tokenCount;
            const hasActualContextUsage = contextTokenCount !== undefined &&
                Number.isFinite(contextTokenCount) &&
                contextTokenCount > 0;
            const reportedContextWindow = contextUsage?.contextWindow;
            if (
                reportedContextWindow !== undefined &&
                Number.isSafeInteger(reportedContextWindow) &&
                reportedContextWindow > 0
            ) {
                providerContextWindow = reportedContextWindow;
            }
            const tokenCount = hasActualContextUsage
                ? contextTokenCount
                : hasActualUsage
                    ? usage.prompt_tokens
                    : estimatedTokens;
            ctx.contextUsage.record({model: ctx.model, provider: ctx.provider, compactCount: ctx.compactState.compactCount},
                invokeMessages, tools, contextUsage?.inputTokens ?? (hasActualUsage ? usage.prompt_tokens : undefined), providerContextWindow);
            usageCalls += 1;
            if (hasActualUsage) {
                usageInputTokens += usage.prompt_tokens;
                usageOutputTokens += usage.completion_tokens;
                usageTotalTokens += usage.total_tokens;
            } else {
                usageInputTokens += tokenCount;
                usageEstimated = true;
            }
            const postState = getTokenWarningState(
                tokenCount,
                ctx.model,
                providerContextWindow,
                ctx.contextSettings
            );
            await onEvent({
                type: "token_update",
                tokenCount,
                percentUsed: postState.percentUsed,
                warning: postState.warning,
                status: hasActualContextUsage || hasActualUsage
                    ? "actual"
                    : "estimated",
            });

            // Without tool calls, the response is expected to be the final answer.
            if (toolCalls.length === 0) {
                if (!textContent && !emptyResponseRetryUsed && hasNextIteration) {
                    history.pop();
                    emptyResponseRetryUsed = true;
                    completionNudge = [
                        "<system-reminder>",
                        "The previous response had neither valid text nor tool calls. Continue from the current task state: use an appropriate tool if work remains, or give a complete final answer in the user's language if finished. Do not return blank content.",
                        "</system-reminder>",
                    ].join("\n");
                    continue;
                }
                const completionReminder = textContent && !completionGateUsed
                    ? formatTodoCompletionReminder(
                        textContent,
                        options.getTodos?.() ?? []
                    )
                    : undefined;
                if (completionReminder && hasNextIteration) {
                    history.pop();
                    completionGateUsed = true;
                    completionNudge = completionReminder;
                    continue;
                }
                if (hasNextIteration) {
                    const queued = inputChannel.drainSafeBoundary();
                    if (queued.length > 0) {
                        if (textContent) {
                            await onEvent({
                                type: "assistant_text",
                                content: textContent,
                                phase: "final",
                            });
                        }
                        await appendQueuedInputs(queued);
                        continue;
                    }
                }
                if (textContent && ctx.runHook) {
                    const hook = await ctx.runHook({hook_event_name: "Stop", session_id: ctx.sessionId,
                        turn_id: turnId, candidate: textContent, continuation_used: hookContinuationUsed});
                    if (ctx.signal.aborted) return interruptedResult();
                    if (hook.error || hook.continueReason) {
                        if (!hook.error && !hookContinuationUsed && hasNextIteration) {
                            history.pop();
                            hookContinuationUsed = true;
                            completionNudge = formatHookContext("Stop", [hook.continueReason!, ...hook.additionalContexts]).join("\n");
                            continue;
                        }
                        const reply = `${textContent}\n\nHook ${hook.error ? "Check failed" : "Continuation limit reached"}: ${hook.error ?? hook.continueReason}`;
                        // Keep the candidate as evidence, with the failed acceptance explicitly attached.
                        history[history.length - 1] = {role: "assistant", content: reply};
                        await onEvent({type: "assistant_text", content: reply, phase: "final"});
                        return {reply, reason: hook.error ? "hook_error" : "hook_limit", iterations: i + 1, ...resultUsage()};
                    }
                }
                if (textContent) {
                    await onEvent({type: "assistant_text", content: textContent, phase: "final"});
                }
                let reply = textContent || "Model returned no valid text or tool calls twice in a row; this turn has stopped.";
                if (!textContent) {
                    await onEvent({
                        type: "assistant_text",
                        content: reply,
                        phase: "final",
                    });
                }
                if (postState.critical) {
                    reply += `\n\n⚠️ Context usage is ${Math.round(postState.percentUsed * 100)}%; consider starting a new session after this turn.`;
                }
                return {
                    reply,
                    reason: textContent ? "completed" : "no_tool_calls",
                    iterations: i + 1,
                    ...resultUsage(),
                };
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
                        "Tool " + name + " was not provided in this model request and was not executed. Use only the provided tools; if none are available, summarize existing evidence.",
                        "denied",
                    )),
                isToolConcurrencySafe: (name, args) => offeredToolNames.has(name) && isToolConcurrencySafeImpl(name, args),
            });
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
                await appendQueuedInputs(inputChannel.drainSafeBoundary());
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
        await draft.finish("discarded");
    }
}
