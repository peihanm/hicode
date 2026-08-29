import type {Message, OpenAITool} from "../llm/types.js";
import type {ToolContext} from "../tools/types.js";
import {getAutoCompactThreshold} from "./window.js";
import {tokenCountWithEstimation} from "./tokens.js";
import {isTurnInterruptedError, throwIfTurnAborted,} from "../runtime/abort.js";
import {buildCompactSummaryMessage} from "./compactPrompt.js";
import {findCompactTailStart} from "./compactTail.js";
import type {CompactState} from "./state.js";
import type {PillarStorageLayout} from "../persistence/index.js";

const DEFAULT_TAIL_MIN_TOKENS = 10_000;
const DEFAULT_TAIL_MIN_TEXT_MESSAGES = 5;
const DEFAULT_TAIL_MAX_TOKENS = 40_000;
const MAX_CONSECUTIVE_COMPACT_FAILURES = 3;

interface CompactHistoryDependencies {
    generateSummary: CompactSummaryGenerator;
}

interface CompactHistoryInput {
    history: Message[];
    ctx: ToolContext;
    tools: OpenAITool[];
    preTokenCount: number;
    keepTailMinTokens?: number;
    keepTailMinTextMessages?: number;
    keepTailMaxTokens?: number;
    force?: boolean;
    trigger?: "auto" | "manual";
    customInstructions?: string;
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
}) => Promise<string>;

interface CompactResult {
    compacted: boolean;
    preTokenCount: number;
    postTokenCount?: number;
    threshold: number;
    message?: string;
}

function envTruthy(value: string | undefined): boolean {
    return value === "1" || value === "true" || value === "yes";
}

function isAutoCompactEnabled(): boolean {
    return !envTruthy(process.env.DISABLE_COMPACT) &&
        !envTruthy(process.env.DISABLE_AUTO_COMPACT);
}

export function shouldAutoCompact(
    tokenCount: number,
    model: string,
    state: CompactState
): boolean {
    if (!isAutoCompactEnabled()) return false;
    if (state.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) return false;
    return tokenCount >= getAutoCompactThreshold(model);
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
                                      keepTailMinTokens = DEFAULT_TAIL_MIN_TOKENS,
                                      keepTailMinTextMessages = DEFAULT_TAIL_MIN_TEXT_MESSAGES,
                                      keepTailMaxTokens = DEFAULT_TAIL_MAX_TOKENS,
                                      force = false,
                                      trigger = "auto",
                                      customInstructions,
                                  }: CompactHistoryInput,
    generateSummary: CompactSummaryGenerator
): Promise<CompactResult> {
    throwIfTurnAborted(ctx.signal);
    const threshold = getAutoCompactThreshold(ctx.model);
    const state = ctx.compactState;

    if (!force && !shouldAutoCompact(preTokenCount, ctx.model, state)) {
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

    try {
        const summary = await generateSummary({
            system,
            conversation: history.slice(1),
            signal: ctx.signal,
            storage: ctx.storage,
            cwd: ctx.cwd,
            model: ctx.model,
            customInstructions,
        });
        throwIfTurnAborted(ctx.signal);
        const summaryMessage = buildCompactSummaryMessage(summary);
        const tailStart = findCompactTailStart(history, {
            minTokens: keepTailMinTokens,
            minTextMessages: keepTailMinTextMessages,
            maxTokens: keepTailMaxTokens,
        });
        const compactedHistory = [system, summaryMessage, ...history.slice(tailStart)];
        const postTokenCount = tokenCountWithEstimation(compactedHistory, tools);

        history.splice(0, history.length, ...compactedHistory);
        state.consecutiveFailures = 0;
        state.compactCount += 1;
        state.lastCompactAt = new Date().toISOString();

        return {
            compacted: true,
            preTokenCount,
            postTokenCount,
            threshold,
        };
    } catch (error) {
        if (isTurnInterruptedError(error, ctx.signal)) throw error;
        if (trigger === "auto") state.consecutiveFailures += 1;
        return {
            compacted: false,
            preTokenCount,
            threshold,
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
