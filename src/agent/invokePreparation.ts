import type {CompactHistoryRunner} from "../context/compact.js";
import {shouldAutoCompact} from "../context/compact.js";
import {tokenCountWithEstimation} from "../context/tokens.js";
import {getAutoCompactThreshold, getModelInputBudget, getTokenWarningState,} from "../context/window.js";
import {getUserContextBlocks} from "../prompt/attachments.js";
import {buildInvokeMessages} from "../prompt/invokeMessages.js";
import {throwIfTurnAborted} from "../runtime/abort.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentEvent} from "./types.js";
import type {Message, OpenAITool} from "../llm/types.js";

export type ToolSchemaProvider = () => OpenAITool[];
export type {CompactHistoryRunner} from "../context/compact.js";

export interface PrepareAgentInvokeInput {
    history: Message[];
    ctx: ToolContext;
    onEvent: (event: AgentEvent) => void | Promise<void>;
    getToolSchemas: ToolSchemaProvider;
    compactHistory: CompactHistoryRunner;
    contextWindow?: number;
    additionalUserContextBlocks?: readonly string[];
}

export interface PreparedAgentInvoke {
    invokeMessages: Message[];
    tools: OpenAITool[];
    estimatedTokens: number;
}

export async function prepareAgentInvoke({
                                             history,
                                             ctx,
                                             onEvent,
                                             getToolSchemas,
                                             compactHistory,
                                             contextWindow,
                                             additionalUserContextBlocks = [],
                                         }: PrepareAgentInvokeInput): Promise<PreparedAgentInvoke> {
    throwIfTurnAborted(ctx.signal);

    let userContextBlocks = [
        ...getUserContextBlocks(ctx.skills, ctx.instructions),
        ...additionalUserContextBlocks,
    ];
    let invokeMessages = buildInvokeMessages(history, userContextBlocks);
    const tools = getToolSchemas();
    let estimatedTokens = tokenCountWithEstimation(invokeMessages, tools);
    const preState = getTokenWarningState(
        estimatedTokens,
        ctx.model,
        contextWindow
    );

    if (
        preState.critical &&
        shouldAutoCompact(
            estimatedTokens,
            ctx.model,
            ctx.compactState,
            contextWindow
        )
    ) {
        await onEvent({
            type: "compact_start",
            tokenCount: estimatedTokens,
            threshold: getAutoCompactThreshold(ctx.model, contextWindow),
            trigger: "auto",
        });
        const compactResult = await compactHistory({
            history,
            ctx,
            tools,
            preTokenCount: estimatedTokens,
            contextWindow,
            additionalUserContextBlocks,
        });
        throwIfTurnAborted(ctx.signal);

        if (compactResult.compacted) {
            userContextBlocks = [
                ...getUserContextBlocks(ctx.skills, ctx.instructions),
                ...additionalUserContextBlocks,
            ];
            invokeMessages = buildInvokeMessages(history, userContextBlocks);
            estimatedTokens = tokenCountWithEstimation(invokeMessages, tools);
            await onEvent({
                type: "compact_end",
                preTokenCount: compactResult.preTokenCount,
                postTokenCount: estimatedTokens,
                trigger: "auto",
            });
        } else if (compactResult.message) {
            await onEvent({
                type: "compact_error",
                message: compactResult.message,
                trigger: "auto",
            });
        }
    }

    if (estimatedTokens > getModelInputBudget(ctx.model, contextWindow)) {
        throw new Error(`当前请求估算 ${estimatedTokens} tokens，超过可用输入预算 ${getModelInputBudget(ctx.model, contextWindow)}；已停止调用模型。请缩短最新输入、减少固定指令/工具，或用新 Session 继续；原历史已保留。`);
    }
    return {invokeMessages, tools, estimatedTokens};
}
