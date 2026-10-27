import {contentText} from "../images/content.js";
import {toolFileChanges} from "../toolResults/uiData.js";
import {randomUUID} from "node:crypto";
import {formatHookContext} from "../hooks/index.js";
import {
    applyBatchToolResultBudget,
    type BatchToolResultEntry,
    type ToolExecutionResult,
    type ToolOutcome,
} from "../toolResults/index.js";
import {isTurnInterruptedError} from "../runtime/abort.js";
import {mapWithConcurrencyLimit, MAX_TOOL_CONCURRENCY, partitionToolCalls,} from "../tools/orchestration.js";
import {formatInterruptedToolResult} from "../tools/registry.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentEvent} from "./types.js";
import type {Message, ToolCall} from "../llm/types.js";
import type {ToolUIData} from "../toolResults/uiData.js";

export type ToolExecutor = (
    name: string,
    argsJson: string,
    ctx: ToolContext,
    toolCallId: string
) => Promise<ToolExecutionResult | string>;

interface ExecuteToolCallBatchInput {
    toolCalls: ToolCall[];
    history: Message[];
    ctx: ToolContext;
    turnId: string;
    onEvent: (event: AgentEvent) => void | Promise<void>;
    executeTool: ToolExecutor;
    isToolConcurrencySafe: (name: string, argsJson: string) => boolean;
}

type ToolCallBatchResult =
    | { status: "completed"; outcomes: ToolCallOutcome[] }
    | { status: "interrupted"; outcomes: ToolCallOutcome[] };

export interface ToolCallOutcome {
    toolCallId: string;
    name: string;
    argsJson: string;
    outcome: ToolOutcome;
    result: string;
    persisted?: ToolExecutionResult["persisted"];
    uiData?: ToolUIData;
}

export async function executeToolCallBatch({
                                               toolCalls,
                                               history,
                                               ctx,
                                               turnId,
                                               onEvent,
                                               executeTool,
                                               isToolConcurrencySafe,
                                           }: ExecuteToolCallBatchInput): Promise<ToolCallBatchResult> {
    let failure: {error: unknown} | undefined;
    const notify = async (event: AgentEvent): Promise<void> => {
        try { await onEvent(event); }
        catch (error) { failure ??= {error}; }
    };
    const throwIfFailed = () => {if (failure) throw failure.error;};
    let nextToolIndex = 0;
    const outcomes: ToolCallOutcome[] = [];
    const startedToolCallIds = new Set<string>();
    let budgetEntries: BatchToolResultEntry[] = [];
    let status: "completed" | "interrupted" | "failed" = "failed";

    const finalizeBudget = async (): Promise<void> => {
        if (budgetEntries.length === 0) return;
        const before = budgetEntries.map(entry => history[entry.messageIndex]?.content);
        const replacements = await applyBatchToolResultBudget({
            history,
            entries: budgetEntries,
            store: ctx.toolResultStore,
        });
        const updates = new Map(replacements.map(update => [update.toolCallId, update]));
        // Clear the pending batch before event callbacks: failures must not repeat delivery.
        const entries = budgetEntries;
        budgetEntries = [];
        for (const [index, entry] of entries.entries()) {
            const message = history[entry.messageIndex];
            const update = updates.get(entry.toolCallId);
            const outcome = outcomes.find(item => item.toolCallId === entry.toolCallId);
            const persisted = update?.status === "saved" ? update.persisted : entry.persisted;
            if (outcome && message?.role === "tool") {
                outcome.result = contentText(message.content);
                outcome.persisted = persisted;
                if (update?.status === "failed" && outcome.outcome === "ok") outcome.outcome = "output_failed";
            }
            const previous = before[index];
            if (message?.role === "tool" && previous !== undefined && message.content !== previous) {
                ctx.fileState.bindOutput(entry.toolCallId, contentText(previous), {modelContent: message.content, persisted});
            }
            if (update?.status === "saved") await notify({type: "tool_result_delivery", toolCallId: entry.toolCallId,
                status: "saved", persisted: update.persisted});
            else if (update?.status === "failed" && outcome) await notify({type: "tool_result_delivery", toolCallId: entry.toolCallId,
                status: "failed", outcome: outcome.outcome, result: update.message});
        }
    };

    const emitStart = async (toolCall: ToolCall): Promise<void> => {
        startedToolCallIds.add(toolCall.id);
        await notify({
            type: "tool_call_start",
            turnId,
            toolCallId: toolCall.id,
            name: toolCall.function.name,
            args: toolCall.function.arguments,
        });
    };

    const appendSyntheticResults = async (
        startIndex: number,
        outcome: "failed" | "interrupted",
        error?: unknown
    ): Promise<void> => {
        const content = outcome === "interrupted"
            ? formatInterruptedToolResult(ctx.signal)
            : `Tool execution error: ${error instanceof Error ? error.message : String(error)}`;
        for (const toolCall of toolCalls.slice(startIndex)) {
            const alreadyPaired = history.some(
                (message) =>
                    message.role === "tool" && message.tool_call_id === toolCall.id
            );
            if (alreadyPaired) continue;
            if (!startedToolCallIds.has(toolCall.id)) {
                await emitStart(toolCall);
            }
            history.push({role: "tool", content, tool_call_id: toolCall.id});
            outcomes.push({toolCallId: toolCall.id, name: toolCall.function.name,
                argsJson: toolCall.function.arguments, outcome, result: content});
            await notify({
                type: "tool_call_end",
                turnId,
                toolCallId: toolCall.id,
                result: content,
                outcome,
            });
        }
    };

    const executeOne = async (toolCall: ToolCall): Promise<ToolExecutionResult> => {
        await emitStart(toolCall);
        if (failure) return {modelContent: "Tool was not executed because the batch failed", displayContent: "Tool was not executed because the batch failed", outcome: "failed"};
        try {
            const execution = await executeTool(
                toolCall.function.name,
                toolCall.function.arguments,
                ctx,
                toolCall.id
            );
            return typeof execution === "string"
                ? {
                    modelContent: execution,
                    displayContent: execution,
                    outcome: "ok",
                }
                : execution;
        } catch (error) {
            failure ??= {error};
            const content = isTurnInterruptedError(error, ctx.signal) ? formatInterruptedToolResult(ctx.signal)
                : `Tool execution error: ${error instanceof Error ? error.message : String(error)}`;
            return {modelContent: content, displayContent: content, outcome: ctx.signal.aborted ? "interrupted" : "failed"};
        }
    };

    try {
        const groups = partitionToolCalls(toolCalls, isToolConcurrencySafe);
        for (const group of groups) {
            throwIfFailed();
            if (ctx.signal.aborted) {
                await appendSyntheticResults(nextToolIndex, "interrupted");
                await finalizeBudget();
                status = "interrupted";
                return {status: "interrupted", outcomes};
            }

            const executions = group.concurrencySafe
                ? await mapWithConcurrencyLimit(
                    group.calls,
                    MAX_TOOL_CONCURRENCY,
                    executeOne
                )
                : [await executeOne(group.calls[0]!)];

            for (let index = 0; index < group.calls.length; index++) {
                const toolCall = group.calls[index]!;
                const execution = executions[index]!;
                if (history.some(message => message.role === "tool" && message.tool_call_id === toolCall.id)) {
                    nextToolIndex++;
                    continue;
                }
                const interrupted = ctx.signal.aborted && toolFileChanges(execution.uiData).length === 0;
                const interruptedContent = interrupted
                    ? formatInterruptedToolResult(ctx.signal)
                    : undefined;
                const messageIndex = history.length;
                history.push({
                    role: "tool",
                    content: interruptedContent ?? execution.modelContent,
                    tool_call_id: toolCall.id,
                });
                if (!interrupted && execution.completedTask) ctx.taskJoin?.record(execution.completedTask);
                if (!interrupted && execution.runningTask) {
                    const task = await ctx.tasks?.get(execution.runningTask);
                    if (!task || task.kind !== "shell") throw new Error("Shell result references an unavailable task");
                    ctx.taskJoin?.register(task);
                }
                outcomes.push({
                    toolCallId: toolCall.id,
                    name: toolCall.function.name,
                    argsJson: toolCall.function.arguments,
                    outcome: interrupted ? "interrupted" : execution.outcome,
                    result: interruptedContent ?? contentText(execution.modelContent),
                    ...(!interrupted && execution.uiData
                        ? {uiData: execution.uiData}
                        : {}),
                });
                if (!interrupted) {
                    budgetEntries.push({
                        messageIndex,
                        toolCallId: toolCall.id,
                        toolName: toolCall.function.name,
                        ...(execution.autoPersist === false ? {autoPersist: false as const} : {}),
                        ...(execution.persisted ? {persisted: execution.persisted} : {}),
                    });
                }
                nextToolIndex += 1;
                await notify({
                    type: "tool_call_end",
                    turnId,
                    toolCallId: toolCall.id,
                    result: interruptedContent ?? execution.displayContent,
                    outcome: interrupted ? "interrupted" : execution.outcome,
                    ...(execution.persisted ? {persisted: execution.persisted} : {}),
                    ...(!interrupted && execution.completedTask ? {completedTask: execution.completedTask} : {}),
                    ...(!interrupted && execution.uiData
                        ? {uiData: execution.uiData}
                        : {}),
                });
            }

            throwIfFailed();
            if (ctx.signal.aborted) {
                await appendSyntheticResults(nextToolIndex, "interrupted");
                await finalizeBudget();
                status = "interrupted";
                return {status: "interrupted", outcomes};
            }
        }

        await finalizeBudget();
        throwIfFailed();
        status = "completed";
        return {status: "completed", outcomes};
    } catch (error) {
        if (isTurnInterruptedError(error, ctx.signal)) {
            await appendSyntheticResults(nextToolIndex, "interrupted");
            await finalizeBudget();
            status = "interrupted";
            return {status: "interrupted", outcomes};
        }
        await appendSyntheticResults(nextToolIndex, "failed", error);
        await finalizeBudget();
        throw error;
    } finally {
        if (ctx.runHook) {
            // Exceptional batches report skipped execution facts without starting new work.
            const signal = status === "completed" ? ctx.signal
                : ctx.signal.aborted ? ctx.signal : AbortSignal.abort("batch-failed");
            try {
                const hook = await ctx.runHook({hook_event_name: "PostToolBatch", session_id: ctx.sessionId,
                    turn_id: turnId, batch_id: randomUUID(), status,
                    tools: outcomes.map(item => ({tool_call_id: item.toolCallId, name: item.name,
                        outcome: item.outcome, summary: item.result.slice(0, 2000),
                        ...(item.persisted ? {result_id: item.persisted.resultId} : {}),
                        changes: toolFileChanges(item.uiData).map(change => ({path: change.path, kind: change.kind}))}))}, signal);
                if (status === "completed" && !signal.aborted && hook.additionalContexts.length) {
                    history.push({role: "user", origin: "runtime" as const, content: formatHookContext("PostToolBatch", hook.additionalContexts).join("\n")});
                }
            } catch (error) {
                if (status === "completed") throw error;
                // A notification failure must not replace the original batch failure/cancellation.
            }
        }
    }
}
