import {DEFAULT_CONTEXT_SETTINGS, type ContextSettings} from "./config.js";

// Context-window configuration and token-threshold state.
// Based on Claude Code src/utils/context.ts getContextWindowForModel
// and services/compact/autoCompact.ts calculateTokenWarningState.

// Reserve tokens for summary output during compaction; Claude Code uses COMPACT_MAX_OUTPUT_TOKENS=20_000.
const RESERVED_FOR_SUMMARY = 20_000;

// Auto-Compact thresholds follow Claude Code services/compact/autoCompact.ts.
// effectiveWindow = contextWindow - summaryReserve
// autoCompactThreshold = effectiveWindow - 13_000
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;

// Infer context-window size from the model name.
function getContextWindowForModel(model: string): number | undefined {
    const normalizedModel = model.toLowerCase();
    if (normalizedModel.includes("glm-5.2")) return 1_000_000;
    if (normalizedModel.includes("glm")) return 128_000;
    if (normalizedModel === "deepseek-pro" || normalizedModel === "deepseek-flash") return 1_000_000;
    if (
        normalizedModel.startsWith("qwen3.8-flash") ||
        normalizedModel.startsWith("qwen3.8-max") ||
        normalizedModel.startsWith("qwen3.7-plus") ||
        normalizedModel.startsWith("qwen3.7-max") ||
        normalizedModel.startsWith("qwen3.6-plus") ||
        normalizedModel.startsWith("qwen3.6-flash") ||
        normalizedModel.startsWith("qwen3-coder-plus")
    ) {
        return 1_000_000;
    }
    if (normalizedModel.startsWith("qwen3-coder-next")) return 262_144;
    return undefined;
}

// Effective context window excludes the summary reserve.
function resolveContextWindow(model: string, reportedWindow: number | undefined, settings: ContextSettings): number {
    if (
        reportedWindow !== undefined &&
        Number.isSafeInteger(reportedWindow) &&
        reportedWindow > 0
    ) {
        return Math.min(settings.windowTokens, reportedWindow);
    }
    return Math.min(settings.windowTokens, getContextWindowForModel(model) ?? settings.windowTokens);
}

export function getModelInputBudget(model: string, reportedWindow?: number, settings: ContextSettings = DEFAULT_CONTEXT_SETTINGS): number {
    const window = resolveContextWindow(model, reportedWindow, settings);
    const outputReserve = Math.min(RESERVED_FOR_SUMMARY, Math.floor(window * 0.2));
    return Math.max(1, window - outputReserve);
}

export function getAutoCompactThreshold(
    model: string,
    reportedWindow?: number,
    settings: ContextSettings = DEFAULT_CONTEXT_SETTINGS
): number {
    return Math.min(settings.autoCompactTokenLimit, Math.max(
        1,
        getModelInputBudget(model, reportedWindow, settings) - Math.min(AUTOCOMPACT_BUFFER_TOKENS, Math.floor(getModelInputBudget(model, reportedWindow, settings) * 0.15))
    ));
}

/** Leave working room instead of compacting to just below the next trigger. */
export function getCompactTarget(model: string, reportedWindow?: number, settings: ContextSettings = DEFAULT_CONTEXT_SETTINGS): number {
    return Math.max(1, Math.floor(Math.min(getModelInputBudget(model, reportedWindow, settings) * 0.65, getAutoCompactThreshold(model, reportedWindow, settings) * 0.8)));
}

function getTokenWarningThreshold(model: string, reportedWindow: number | undefined, settings: ContextSettings): number {
    return Math.max(
        1,
        getAutoCompactThreshold(model, reportedWindow, settings) - WARNING_THRESHOLD_BUFFER_TOKENS
    );
}

export interface TokenWarningState {
    percentUsed: number; // 0-1
    warning: boolean; // Approaching the auto-compaction threshold.
    critical: boolean; // Above the auto-compaction threshold.
}

// Compute warning state from token usage.
// Fixed warning/critical token buffers reflect remaining capacity better than percentages.
export function getTokenWarningState(
    tokenCount: number,
    model: string,
    reportedWindow?: number,
    settings: ContextSettings = DEFAULT_CONTEXT_SETTINGS
): TokenWarningState {
    const effective = getModelInputBudget(model, reportedWindow, settings);
    const autoCompactThreshold = getAutoCompactThreshold(model, reportedWindow, settings);
    const percentUsed = Math.min(1, tokenCount / effective);
    const critical = tokenCount >= autoCompactThreshold;
    return {
        percentUsed,
        warning: tokenCount >= getTokenWarningThreshold(model, reportedWindow, settings),
        critical,
    };
}
