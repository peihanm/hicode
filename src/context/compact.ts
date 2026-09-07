import {formatHookContext} from "../hooks/index.js";
import type {Message, OpenAITool} from "../llm/types.js";
import type {ToolContext} from "../tools/types.js";
import {getAutoCompactThreshold} from "./window.js";
import {estimateMessageTokens, tokenCountWithEstimation} from "./tokens.js";
import {isTurnInterruptedError, throwIfTurnAborted,} from "../runtime/abort.js";
import {buildCompactSummaryMessage} from "./compactPrompt.js";
import {findCompactTailStart} from "./compactTail.js";
import {getUserContextBlocks} from "../prompt/attachments.js";
import {buildInvokeMessages} from "../prompt/invokeMessages.js";
import type {CompactState} from "./state.js";
import type {PillarStorageLayout} from "../persistence/index.js";

const DEFAULT_TAIL_MIN_TOKENS = 10_000;
const DEFAULT_TAIL_MIN_TEXT_MESSAGES = 5;
const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

interface CompactHistoryDependencies {
    generateSummary: CompactSummaryGenerator;
}

interface CompactHistoryInput {
    history: Message[];
    ctx: ToolContext;
    tools: OpenAITool[];
    preTokenCount: number;
    contextWindow?: number;
    force?: boolean;
    trigger?: "auto" | "manual";
    customInstructions?: string;
    additionalUserContextBlocks?: readonly string[];
}

export type CompactHistoryRunner = (
    input: CompactHistoryInput
) => Promise<CompactResult>;

type CompactSummaryGenerator = (input: {
    system: Extract<Message, { role: "system" }>;
    conversation: Message[];
    signal: AbortSignal;
    storage: PillarStorageLayout;
    cwd: string;
    model: string;
    customInstructions?: string;
    contextWindow?: number;
}) => Promise<string>;

interface CompactResult {
    compacted: boolean;
    preTokenCount: number;
    postTokenCount?: number;
    threshold: number;
    message?: string;
}

export function shouldAutoCompact(
    tokenCount: number,
    model: string,
    state: CompactState,
    contextWindow?: number
): boolean {
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) return false;
    return tokenCount >= getAutoCompactThreshold(model, contextWindow);
}

export function createCompactHistoryRunner(
    dependencies: CompactHistoryDependencies
): CompactHistoryRunner {
    return (input) => compactHistoryCore(input, dependencies.generateSummary);
}

async function compactHistoryCore({
                                      history,
                                      ctx,
                                      tools,
                                      preTokenCount,
                                      contextWindow,
                                      force = false,
                                      trigger = "auto",
                                      customInstructions,
                                      additionalUserContextBlocks = [],
                                  }: CompactHistoryInput,
    generateSummary: CompactSummaryGenerator
): Promise<CompactResult> {
    throwIfTurnAborted(ctx.signal);
    const threshold = getAutoCompactThreshold(ctx.model, contextWindow);
    const state = ctx.compactState;

    if (!force && !shouldAutoCompact(
        preTokenCount,
        ctx.model,
        state,
        contextWindow
    )) {
        return {compacted: false, preTokenCount, threshold};
    }

    const system = history[0];
    if (!system || system.role !== "system") {
        return {
            compacted: false,
            preTokenCount,
            threshold,
            message: "history 缺少 system message，跳过 compact",
        };
    }

    if (history.length <= 3) {
        return {
            compacted: false,
            preTokenCount,
            threshold,
            message: "history 太短，跳过 compact",
        };
    }

    const releaseHookConfiguration = ctx.holdHookConfiguration?.();
    let attempted = false;
    let postDispatched = false;
    try {
        const contextBlocks = [...getUserContextBlocks(ctx.skills, ctx.instructions), ...additionalUserContextBlocks];
        const fixedTokens = tokenCountWithEstimation(buildInvokeMessages([system, {role: "user", content: ""}], contextBlocks), tools);
        const latestUserIndex = history.findLastIndex(message => message.role === "user");
        const latestUser = latestUserIndex > 0 ? history[latestUserIndex]! : undefined;
        const latestUserTokens = latestUser ? estimateMessageTokens(latestUser) : 0;
        if (fixedTokens + latestUserTokens >= threshold) {
            throw new Error("固定上下文与最新用户任务无法容纳压缩摘要；请缩短输入、指令或工具范围，原历史已保留");
        }
        const actualPreTokens = tokenCountWithEstimation(buildInvokeMessages(history, contextBlocks), tools);
        attempted = true;
        const preHook = await ctx.runHook?.({hook_event_name: "PreCompact", session_id: ctx.sessionId,
            turn_id: ctx.turnId, trigger, token_count: actualPreTokens, instructions: customInstructions});
        throwIfTurnAborted(ctx.signal);
        const summary = await generateSummary({
            system,
            conversation: history.slice(1),
            signal: ctx.signal,
            storage: ctx.storage,
            cwd: ctx.cwd,
            model: ctx.model,
            customInstructions: [customInstructions, ...formatHookContext("PreCompact", preHook?.additionalContexts ?? [])]
                .filter(Boolean).join("\n") || undefined,
            contextWindow,
        });
        throwIfTurnAborted(ctx.signal);
        if (!summary.trim()) throw new Error("compact summary 为空");
        const summaryMessage = buildCompactSummaryMessage(summary);
        const summaryTokens = estimateMessageTokens(summaryMessage);
        const tailBudget = Math.max(0, threshold - fixedTokens - summaryTokens);
        const tailStart = findCompactTailStart(history, {
            minTokens: Math.min(DEFAULT_TAIL_MIN_TOKENS, Math.floor(tailBudget / 4)),
            minTextMessages: DEFAULT_TAIL_MIN_TEXT_MESSAGES,
            maxTokens: tailBudget,
        });
        let compactedHistory: Message[] | undefined;
        let postTokenCount = 0;
        let tailTokens = history.slice(tailStart).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        for (let start = tailStart; start <= history.length; start++) {
            if (start > tailStart) tailTokens -= estimateMessageTokens(history[start - 1]!);
            if (history[start]?.role === "tool") continue;
            const preserveUser = latestUser && latestUserIndex < start;
            const candidateTokens = fixedTokens + summaryTokens + tailTokens + (preserveUser ? latestUserTokens : 0);
            if (candidateTokens >= threshold || candidateTokens >= actualPreTokens) continue;
            compactedHistory = [system, summaryMessage, ...(preserveUser ? [latestUser] : []), ...history.slice(start)];
            postTokenCount = tokenCountWithEstimation(buildInvokeMessages(compactedHistory, contextBlocks), tools);
            break;
        }
        if (!compactedHistory || postTokenCount >= threshold || postTokenCount >= actualPreTokens) {
            throw new Error("压缩候选未减少最终请求或没有足够窗口余量，原历史已保留；请缩短输入或减少固定上下文");
        }
        throwIfTurnAborted(ctx.signal);

        history.splice(0, history.length, ...compactedHistory);
        state.consecutiveFailures = 0;
        state.compactCount += 1;
        state.lastCompactAt = new Date().toISOString();
        postDispatched = true;
        const postHook = await ctx.runHook?.({hook_event_name: "PostCompact", session_id: ctx.sessionId,
            turn_id: ctx.turnId, trigger, status: "success", pre_token_count: actualPreTokens, post_token_count: postTokenCount});
        if (postHook?.additionalContexts.length && !ctx.signal.aborted) {
            // Keep the context attached to this summary, without pinning it across future compactions.
            const context = formatHookContext("PostCompact", postHook.additionalContexts).join("\n");
            const candidate = [...history];
            candidate[1] = {...summaryMessage, content: `${summaryMessage.content}\n${context}`};
            const tokens = tokenCountWithEstimation(buildInvokeMessages(candidate, contextBlocks), tools);
            if (tokens < threshold && tokens < actualPreTokens) {
                history.splice(0, history.length, ...candidate);
                postTokenCount = tokens;
            }
        }

        return {
            compacted: true,
            preTokenCount,
            postTokenCount,
            threshold,
        };
    } catch (error) {
        if (postDispatched) throw error;
        if (attempted && !postDispatched) {
            postDispatched = true;
            await ctx.runHook?.({hook_event_name: "PostCompact", session_id: ctx.sessionId,
                turn_id: ctx.turnId, trigger, status: ctx.signal.aborted ? "cancelled" : "failed",
                pre_token_count: preTokenCount, post_token_count: preTokenCount,
                reason: ctx.signal.aborted ? "cancelled" : "summary_failed"});
        }
        if (isTurnInterruptedError(error, ctx.signal)) throw error;
        if (trigger === "auto") state.consecutiveFailures += 1;
        return {
            compacted: false,
            preTokenCount,
            threshold,
            message: error instanceof Error ? error.message : String(error),
        };
    } finally {releaseHookConfiguration?.();}
}
