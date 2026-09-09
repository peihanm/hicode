import type {CompactHistoryRunner} from "../context/compact.js";
import {shouldAutoCompact} from "../context/compact.js";
import {getAutoCompactThreshold, getModelInputBudget, getTokenWarningState,} from "../context/window.js";
import {getUserContextBlocks} from "../prompt/attachments.js";
import {buildInvokeMessages} from "../prompt/invokeMessages.js";
import {throwIfTurnAborted} from "../runtime/abort.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentEvent} from "./types.js";
import type {Message, OpenAITool} from "../llm/types.js";
import type {Todo} from "../todos.js";
import {buildLiveStateContext} from "../context/liveState.js";

export type ToolSchemaProvider = () => OpenAITool[];
export type {CompactHistoryRunner} from "../context/compact.js";

export interface PrepareAgentInvokeInput {
    history: Message[];
    ctx: ToolContext;
    onEvent: (event: AgentEvent) => void | Promise<void>;
    getToolSchemas: ToolSchemaProvider;
    compactHistory: CompactHistoryRunner;
    contextWindow?: number;
    forceCompact?: boolean;
    additionalUserContextBlocks?: readonly string[];
    getAdditionalUserContextBlocks?: () => Promise<readonly string[]>;
    getTodos?: () => readonly Todo[];
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
                                             forceCompact = false,
                                             additionalUserContextBlocks = [],
                                             getTodos,
                                             getAdditionalUserContextBlocks,
                                         }: PrepareAgentInvokeInput): Promise<PreparedAgentInvoke> {
    throwIfTurnAborted(ctx.signal);

    const getRuntimeBlocks = async () => [...additionalUserContextBlocks,...(await getAdditionalUserContextBlocks?.()??[]), ...buildLiveStateContext(getTodos?.(), ctx.tasks)];
    let runtimeBlocks = await getRuntimeBlocks();
    let userContextBlocks = [
        ...getUserContextBlocks(ctx.skills, ctx.instructions),
        ...runtimeBlocks,
    ];
    let invokeMessages = [...buildInvokeMessages(history, userContextBlocks)];
    const tools = getToolSchemas();
    const scope = () => ({model: ctx.model, provider: ctx.provider, compactCount: ctx.compactState.compactCount});
    contextWindow ??= ctx.contextUsage.contextWindow(scope());
    let estimatedTokens = ctx.contextUsage.estimate(scope(), invokeMessages, tools);
    const preState = getTokenWarningState(
        estimatedTokens,
        ctx.model,
        contextWindow
    );

    if (
        forceCompact || (preState.critical &&
        shouldAutoCompact(
            estimatedTokens,
            ctx.model,
            ctx.compactState,
            contextWindow
        ))
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
            additionalUserContextBlocks: runtimeBlocks,
            force: forceCompact,
        });
        throwIfTurnAborted(ctx.signal);

        if (compactResult.compacted) {
            ctx.contextUsage.reset();
            runtimeBlocks = await getRuntimeBlocks();
            userContextBlocks = [
                ...getUserContextBlocks(ctx.skills, ctx.instructions),
                ...runtimeBlocks,
            ];
            invokeMessages = [...buildInvokeMessages(history, userContextBlocks)];
            estimatedTokens = ctx.contextUsage.estimate(scope(), invokeMessages, tools);
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
        if (forceCompact && !compactResult.compacted) throw new Error(`超长上下文恢复失败：${compactResult.message ?? "未能压缩"}；已停止重发请求，原历史保留`);
    }

    if (estimatedTokens > getModelInputBudget(ctx.model, contextWindow)) {
        throw new Error(`当前请求估算 ${estimatedTokens} tokens，超过可用输入预算 ${getModelInputBudget(ctx.model, contextWindow)}；已停止调用模型。请缩短最新输入、减少固定指令/工具，或用新 Session 继续；原历史已保留。`);
    }
    return {invokeMessages, tools, estimatedTokens};
}
