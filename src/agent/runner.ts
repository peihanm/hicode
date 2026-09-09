import type {MessageContent} from "../images/content.js";
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
    createTurnCompletionState,
    formatTodoCompletionReminder,
    formatCompletionContext,
    recordToolOutcomes,
} from "./turnCompletion.js";
import type {AgentInputChannel, QueuedAgentInput} from "./inputChannel.js";
import type {Todo} from "../todos.js";
import {TodoProgress} from "./todoProgress.js";

export interface AgentToolBindings {
    getToolSchemas: ToolSchemaProvider;
    executeTool: ToolExecutor;
    isToolConcurrencySafe: (name: string, argsJson: string) => boolean;
}

export interface AgentRunOptions extends AgentToolBindings {
    maxIterations?: number;
    /** 读取 Host-owned Todo 真相源，供进度提醒与最终状态校验。 */
    getTodos?: () => readonly Todo[];
    /** 连续权限拒绝达到该值时停止工具阶段，供无交互子 Runtime 使用。 */
    maxConsecutiveDeniedToolCalls?: number;
    /** 当前 turn 的宿主上下文，不写入持久 history。 */
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
        throw new Error(`模型重复使用历史 Tool Call ID: ${duplicate.id}`);
    }
}

// Agent 主循环：调 LLM → 执行工具 → 回喂结果 → 循环，直到 LLM 给出最终回答
// needsFollowUp 模式：LLM 调了工具就继续，没调就停（参考 claude-code query.ts）
//
// onEvent 回调：把进度流给 UI 层（替代 console.log），让 UI 自己决定怎么渲染
// ctx：注入 confirm 等依赖，避免工具直接耦合 readline / Ink

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
    const completionState = createTurnCompletionState();
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
    let providerContextWindow: number | undefined;

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
            reply: "(任务已取消)",
            reason: "interrupted",
            iterations,
            abortReason,
            ...resultUsage(),
        };
    };

    const appendQueuedInputs = (inputs: readonly QueuedAgentInput[]) => {
        for (const input of inputs) {
            history.push({role: "user", content: input.content});
        }
    };

    // 已完成任务的通知先于新问题注入；它们是临时运行时消息，不触发独立 LLM turn。
    appendQueuedInputs(inputChannel.drainInitial());
    // push 真实用户输入到 history（userContext 不入 history）
    history.push({role: "user", content: userInput});

    try {
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
            const evidenceContext = formatCompletionContext(completionState);
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
                getTodos: options.getTodos,
                getAdditionalUserContextBlocks:options.getAdditionalUserContextBlocks,
                additionalUserContextBlocks: [
                    ...(options.additionalUserContextBlocks ?? []),
                    ...(evidenceContext ? [evidenceContext] : []),
                    ...(todoReminder ? [todoReminder] : []),
                    ...(completionNudge ? [completionNudge] : []),
                ],
            });
            completionNudge = undefined;
            // This request's exposure is immutable even if discovery changes during the batch.
            const offeredToolNames = new Set(tools.map(tool => tool.function.name));

            // 调 LLM（用 invokeMessages，不是 history）
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
                    reference => ctx.imageAccess!.read(reference)
                );
            } finally {
                await onEvent({type: "model_stream_end"});
            }
            const {message, toolCalls, usage, contextUsage} = llmResult;
            throwIfTurnAborted(ctx.signal);
            ctx.fileState.commitVisible(invokeMessages);
            assertFreshToolCallIds(history, toolCalls);
            // assistant message 和 tool result 入 history（真实对话内容）
            history.push(message);
            const rawTextContent =
                typeof message.content === "string" ? message.content : "";
            const textContent = rawTextContent.trim().length > 0
                ? rawTextContent
                : "";

            // OpenAI-compatible 中转站不一定返回流式 usage。prompt_tokens=0 对
            // 当前非空请求不可能是有效统计；此时保留 preparation 的上下文估算，
            // 不能把“缺失 usage”伪装成真实的 0 tokens。
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
                providerContextWindow
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

            // needsFollowUp = false：LLM 没调工具，应该是给最终回答了
            if (toolCalls.length === 0) {
                if (!textContent && !emptyResponseRetryUsed && hasNextIteration) {
                    history.pop();
                    emptyResponseRetryUsed = true;
                    completionNudge = [
                        "<system-reminder>",
                        "上一次模型响应没有有效正文或工具调用。请从当前任务状态继续：需要操作就调用合适的工具；已经完成就输出完整最终回答。不要返回空白内容。",
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
                        appendQueuedInputs(queued);
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
                        const reply = `${textContent}\n\nHook ${hook.error ? "检查失败" : "续跑上限已到"}: ${hook.error ?? hook.continueReason}`;
                        // Keep the candidate as evidence, with the failed acceptance explicitly attached.
                        history[history.length - 1] = {role: "assistant", content: reply};
                        await onEvent({type: "assistant_text", content: reply, phase: "final"});
                        return {reply, reason: hook.error ? "hook_error" : "hook_limit", iterations: i + 1, ...resultUsage()};
                    }
                }
                if (textContent) {
                    await onEvent({type: "assistant_text", content: textContent, phase: "final"});
                }
                let reply = textContent || "模型连续两次未返回有效正文或工具调用，已停止本轮。";
                if (!textContent) {
                    await onEvent({
                        type: "assistant_text",
                        content: reply,
                        phase: "final",
                    });
                }
                if (postState.critical) {
                    reply += `\n\n⚠️ 上下文已用 ${Math.round(postState.percentUsed * 100)}%，建议结束本轮后开新会话。`;
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
                        "工具 " + name + " 未在本次模型请求中提供，未执行。请仅使用本次提供的工具；没有工具时直接总结已有证据。",
                        "denied",
                    )),
                isToolConcurrencySafe: (name, args) => offeredToolNames.has(name) && isToolConcurrencySafeImpl(name, args),
            });
            if (batchResult.status === "interrupted" || ctx.signal.aborted) {
                return interruptedResult();
            }
            recordToolOutcomes(completionState, batchResult.outcomes, ctx.cwd);
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
            if (denialLimitReached) {
                return {
                    reply: `(连续 ${maxConsecutiveDeniedToolCalls} 次工具调用被权限策略拒绝，已停止工具阶段)`,
                    reason: "permission_denied",
                    iterations: i + 1,
                    ...resultUsage(),
                };
            }
            if (hasNextIteration) {
                appendQueuedInputs(inputChannel.drainSafeBoundary());
            }
        }

        if (maxIterations === undefined) {
            throw new Error("未设迭代上限的 Agent 主循环意外退出");
        }
        const reply = `(达到最大迭代次数 ${maxIterations}，已停止)`;
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
            const reply = `Hook 检查故障，已停止本轮: ${error.message}`;
            await onEvent({type: "assistant_text", content: reply, phase: "final"});
            return {reply, reason: "hook_error", iterations, ...resultUsage()};
        }
        throw error;
    } finally {
        await draft.finish("discarded");
    }
}
