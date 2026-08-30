import type {CompactHistoryRunner} from "../context/compact.js";
import {shouldAutoCompact} from "../context/compact.js";
import {tokenCountWithEstimation} from "../context/tokens.js";
import {getAutoCompactThreshold, getTokenWarningState,} from "../context/window.js";
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
    const preState = getTokenWarningState(estimatedTokens, ctx.model);

    if (
        preState.critical &&
        shouldAutoCompact(estimatedTokens, ctx.model, ctx.compactState)
    ) {
        await onEvent({
            type: "compact_start",
            tokenCount: estimatedTokens,
            threshold: getAutoCompactThreshold(ctx.model),
            trigger: "auto",
        });
        const compactResult = await compactHistory({
            history,
            ctx,
            tools,
            preTokenCount: estimatedTokens,
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

    return {invokeMessages, tools, estimatedTokens};
}
