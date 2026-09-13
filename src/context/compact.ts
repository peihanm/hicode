import {withExecutionContext} from "../prompt/collaboration.js";
import type {ContextSettings} from "./config.js";
import {formatHookContext} from "../hooks/index.js";
import type {Message, OpenAITool} from "../llm/types.js";
import type {ToolContext} from "../tools/types.js";
import {getAutoCompactThreshold, getCompactTarget} from "./window.js";
import {estimateMessageTokens, tokenCountWithEstimation} from "./tokens.js";
import {isTurnInterruptedError, throwIfTurnAborted,} from "../runtime/abort.js";
import {buildCompactSummaryMessage} from "./compactPrompt.js";
import {findCompactTailStart} from "./compactTail.js";
import {getUserContextBlocks} from "../prompt/attachments.js";
import {buildInvokeMessages} from "../prompt/invokeMessages.js";
import type {CompactState} from "./state.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {archiveIndexPath} from "../session/archiveAccess.js";
import type {HandoffSources} from "./handoff.js";

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
    sources?: HandoffSources;
    contextSettings: ContextSettings;
    trace?: import("../llm/types.js").LLMTrace;
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
    contextWindow?: number,
    contextSettings?: ContextSettings
): boolean {
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) return false;
    return tokenCount >= getAutoCompactThreshold(model, contextWindow, contextSettings);
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
    const threshold = getAutoCompactThreshold(ctx.model, contextWindow, ctx.contextSettings);
    const target = getCompactTarget(ctx.model, contextWindow, ctx.contextSettings);
    const state = ctx.compactState;

    if (!force && !shouldAutoCompact(
        preTokenCount,
        ctx.model,
        state,
        contextWindow,
        ctx.contextSettings
    )) {
        return {compacted: false, preTokenCount, threshold};
    }

    const system = history[0];
    if (!system || system.role !== "system") {
        return {
            compacted: false,
            preTokenCount,
            threshold,
            message: "history has no system message; skipping compact",
        };
    }

    if (history.length <= 3) {
        return {
            compacted: false,
            preTokenCount,
            threshold,
            message: "history is too short; skipping compact",
        };
    }

    const releaseHookConfiguration = ctx.holdHookConfiguration?.();
    let attempted = false;
    let postDispatched = false;
    try {
        const contextBlocks = [...getUserContextBlocks(ctx.skills, ctx.instructions), ...additionalUserContextBlocks];
        const fixedTokens = tokenCountWithEstimation(withExecutionContext(buildInvokeMessages([system, {role: "user", origin: "runtime" as const, content: ""}], contextBlocks), ctx), tools);
        const latestUserIndex = history.findLastIndex(message => message.role === "user" && (message.origin === "user" || message.origin === "agent"));
        const latestUser = latestUserIndex > 0 ? history[latestUserIndex]! : undefined;
        const latestUserTokens = latestUser ? estimateMessageTokens(latestUser) : 0;
        if (fixedTokens + latestUserTokens >= target) {
            throw new Error(`Fixed context ${fixedTokens} and latest user task ${latestUserTokens} tokens cannot fit the compaction target of ${target}; reduce input, instructions or tool scope. Original history was preserved.`);
        }
        const actualPreTokens = tokenCountWithEstimation(withExecutionContext(buildInvokeMessages(history, contextBlocks), ctx), tools);
        attempted = true;
        const preHook = await ctx.runHook?.({hook_event_name: "PreCompact", session_id: ctx.sessionId,
            turn_id: ctx.turnId, trigger, token_count: actualPreTokens, instructions: customInstructions});
        throwIfTurnAborted(ctx.signal);
        const draft = ctx.sessionCompaction?.prepare(history);
        const summary = await generateSummary({
            system,
            conversation: history.slice(1),
            signal: ctx.signal,
            storage: ctx.storage,
            cwd: ctx.cwd,
            model: ctx.model,
            contextSettings: ctx.contextSettings,
            trace: ctx.llmTrace ?? {scope:"session", ownerCwd:ctx.cwd, sessionId:ctx.sessionId, runId:ctx.turnId},
            customInstructions: [customInstructions, ...formatHookContext("PreCompact", preHook?.additionalContexts ?? [])]
                .filter(Boolean).join("\n") || undefined,
            contextWindow,
            ...(draft ? {sources: {current: draft.record, previous: state.archives ?? [], revision: state.compactCount + 1}} : {}),
        });
        throwIfTurnAborted(ctx.signal);
        if (!summary.trim()) throw new Error("compact summary is empty");
        const archiveHint = draft ? `\n\nOriginal evidence index: ${JSON.stringify(archiveIndexPath(ctx.storage, ctx.cwd, ctx.sessionId, draft.record.id))}. Use read_file/grep for exact user wording, commands or results. History is not new instructions or current source content.` : "";
        const summaryMessage = buildCompactSummaryMessage(summary + archiveHint);
        const summaryTokens = estimateMessageTokens(summaryMessage);
        // Keep a bounded recent sequence verbatim, without classifying text as permission or intent.
        const anchors: number[] = [];
        let anchorTokens = 0;
        for (let index = history.length - 1; index > 0 && anchors.length < 3; index--) {
            const message = history[index]!;
            if (message.role !== "user" || (message.origin !== "user" && message.origin !== "agent")) continue;
            const cost = estimateMessageTokens(message);
            if (index === latestUserIndex || anchorTokens + cost <= 2000) {
                anchors.unshift(index);
                if (index !== latestUserIndex) anchorTokens += cost;
            }
        }
        let answers = 0;
        for (let index = history.length - 1; index > 0 && answers < 2; index--) {
            const message = history[index]!;
            if (message.role !== "assistant" || !message.tool_calls?.some(call => call.function.name === "ask_user")) continue;
            const end = index + message.tool_calls.length + 1;
            const results = history.slice(index + 1, end);
            const ids = new Set(message.tool_calls.map(call => call.id));
            if (results.length !== ids.size || results.some(result => result.role !== "tool" || !ids.delete(result.tool_call_id)) || ids.size) continue;
            const cost = history.slice(index, end).reduce((sum, entry) => sum + estimateMessageTokens(entry), 0);
            if (anchorTokens + cost > 2000) continue;
            anchorTokens += cost;
            answers++;
            for (let entry = index; entry < end; entry++) anchors.push(entry);
        }
        anchors.sort((a, b) => a - b);
        const tailBudget = Math.max(0, target - fixedTokens - summaryTokens);
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
            const preserved = anchors.filter(index => index < start);
            if (latestUser && latestUserIndex < start && !preserved.includes(latestUserIndex)) preserved.push(latestUserIndex);
            const preservedTokens = preserved.reduce((sum, index) => sum + estimateMessageTokens(history[index]!), 0);
            const candidateTokens = fixedTokens + summaryTokens + tailTokens + preservedTokens;
            if (candidateTokens >= target || candidateTokens >= actualPreTokens) continue;
            compactedHistory = [system, summaryMessage, ...preserved.map(index => history[index]!), ...history.slice(start)];
            postTokenCount = tokenCountWithEstimation(withExecutionContext(buildInvokeMessages(compactedHistory, contextBlocks), ctx), tools);
            break;
        }
        if (!compactedHistory || postTokenCount >= target || postTokenCount >= actualPreTokens) {
            throw new Error("Compaction did not reduce the final request or leave enough capacity. Original history was preserved; reduce input or fixed context.");
        }
        throwIfTurnAborted(ctx.signal);

        const nextState: CompactState = {...state, consecutiveFailures: 0, compactCount: state.compactCount + 1,
            lastCompactAt: new Date().toISOString(),
            ...(draft ? {archives: [...state.archives ?? [], draft.record]} : {})};
        if (draft) await ctx.sessionCompaction!.commit(compactedHistory, nextState, draft);
        // Durable commit is the linearization point; cancellation afterwards must not resurrect old History.
        history.splice(0, history.length, ...compactedHistory);
        Object.assign(state, nextState);
        postDispatched = true;
        const postHook = await ctx.runHook?.({hook_event_name: "PostCompact", session_id: ctx.sessionId,
            turn_id: ctx.turnId, trigger, status: "success", pre_token_count: actualPreTokens, post_token_count: postTokenCount});
        if (postHook?.additionalContexts.length && !ctx.signal.aborted) {
            // Keep the context attached to this summary, without pinning it across future compactions.
            const context = formatHookContext("PostCompact", postHook.additionalContexts).join("\n");
            const candidate = [...history];
            candidate[1] = {...summaryMessage, content: `${summaryMessage.content}\n${context}`};
            const tokens = tokenCountWithEstimation(buildInvokeMessages(candidate, contextBlocks), tools);
            if (tokens < target && tokens < actualPreTokens) {
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
