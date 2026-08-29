import {
    applyBatchToolResultBudget,
    type BatchToolResultEntry,
    type ToolExecutionResult,
    type ToolOutcome,
} from "../toolResults/index.js";
import {isTurnInterruptedError} from "../runtime/abort.js";
import {getMaxToolConcurrency, mapWithConcurrencyLimit, partitionToolCalls,} from "../tools/orchestration.js";
import {formatInterruptedToolResult} from "../tools/registry.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentEvent} from "./types.js";
import type {Message, ToolCall} from "../llm/types.js";
import type {ToolUIData} from "../fileChanges/index.js";

export type ToolExecutor = (
    name: string,
    argsJson: string,
    ctx: ToolContext,
    toolCallId: string
) => Promise<ToolExecutionResult | string>;

export interface ExecuteToolCallBatchInput {
    toolCalls: ToolCall[];
    history: Message[];
    ctx: ToolContext;
    turnId: string;
    onEvent: (event: AgentEvent) => void | Promise<void>;
    executeTool: ToolExecutor;
    isToolConcurrencySafe: (name: string, argsJson: string) => boolean;
}

export type ToolCallBatchResult =
    | { status: "completed"; outcomes: ToolCallOutcome[] }
    | { status: "interrupted"; outcomes: ToolCallOutcome[] };

export interface ToolCallOutcome {
    toolCallId: string;
    name: string;
    argsJson: string;
    outcome: ToolOutcome;
    result: string;
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
    let nextToolIndex = 0;
    const outcomes: ToolCallOutcome[] = [];
    const startedToolCallIds = new Set<string>();
    let budgetEntries: BatchToolResultEntry[] = [];

    const finalizeBudget = async (): Promise<void> => {
        if (budgetEntries.length === 0) return;
        const replacements = await applyBatchToolResultBudget({
            history,
            entries: budgetEntries,
            store: ctx.toolResultStore,
        });
        budgetEntries = [];
        for (const replacement of replacements) {
            await onEvent({
                type: "tool_result_persisted",
                toolCallId: replacement.toolCallId,
                persisted: replacement.persisted,
            });
        }
    };

    const emitStart = async (toolCall: ToolCall): Promise<void> => {
        startedToolCallIds.add(toolCall.id);
        await onEvent({
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
            : `工具执行出错: ${error instanceof Error ? error.message : String(error)}`;
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
            await onEvent({
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
    };

    try {
        const groups = partitionToolCalls(toolCalls, isToolConcurrencySafe);
        for (const group of groups) {
            if (ctx.signal.aborted) {
                await appendSyntheticResults(nextToolIndex, "interrupted");
                await finalizeBudget();
                return {status: "interrupted", outcomes};
            }

            const executions = group.concurrencySafe
                ? await mapWithConcurrencyLimit(
                    group.calls,
                    getMaxToolConcurrency(),
                    executeOne
                )
                : [await executeOne(group.calls[0]!)];

            for (let index = 0; index < group.calls.length; index++) {
                const toolCall = group.calls[index]!;
                const execution = executions[index]!;
                const interrupted = ctx.signal.aborted;
                const interruptedContent = interrupted
                    ? formatInterruptedToolResult(ctx.signal)
                    : undefined;
                await onEvent({
                    type: "tool_call_end",
                    turnId,
                    toolCallId: toolCall.id,
                    result: interruptedContent ?? execution.displayContent,
                    outcome: interrupted ? "interrupted" : execution.outcome,
                    ...(execution.persisted ? {persisted: execution.persisted} : {}),
                    ...(!interrupted && execution.uiData
                        ? {uiData: execution.uiData}
                        : {}),
                });
                const messageIndex = history.length;
                history.push({
                    role: "tool",
                    content: interruptedContent ?? execution.modelContent,
                    tool_call_id: toolCall.id,
                });
                outcomes.push({
                    toolCallId: toolCall.id,
                    name: toolCall.function.name,
                    argsJson: toolCall.function.arguments,
                    outcome: interrupted ? "interrupted" : execution.outcome,
                    result: interruptedContent ?? execution.modelContent,
                    ...(!interrupted && execution.uiData
                        ? {uiData: execution.uiData}
                        : {}),
                });
                if (!interrupted) {
                    budgetEntries.push({
                        messageIndex,
                        toolCallId: toolCall.id,
                        toolName: toolCall.function.name,
                        ...(execution.persisted ? {persisted: execution.persisted} : {}),
                    });
                }
                nextToolIndex += 1;
            }

            if (ctx.signal.aborted) {
                await appendSyntheticResults(nextToolIndex, "interrupted");
                await finalizeBudget();
                return {status: "interrupted", outcomes};
            }
        }

        await finalizeBudget();
        return {status: "completed", outcomes};
    } catch (error) {
        if (isTurnInterruptedError(error, ctx.signal)) {
            await appendSyntheticResults(nextToolIndex, "interrupted");
            await finalizeBudget();
            return {status: "interrupted", outcomes};
        }
        await appendSyntheticResults(nextToolIndex, "failed", error);
        await finalizeBudget();
        throw error;
    }
}
