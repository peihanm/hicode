import {DEFAULT_CONTEXT_SETTINGS, type ContextSettings} from "./config.js";

// 上下文窗口配置 + token 阈值状态
// 参考 claude-code src/utils/context.ts（getContextWindowForModel）
// 和 src/services/compact/autoCompact.ts:93-145（calculateTokenWarningState）

// 预留给压缩时 summary 输出的 token（claude-code COMPACT_MAX_OUTPUT_TOKENS = 20_000）
const RESERVED_FOR_SUMMARY = 20_000;

// Auto-Compact 阈值参考 claude-code services/compact/autoCompact.ts：
// effectiveWindow = contextWindow - summaryReserve
// autoCompactThreshold = effectiveWindow - 13_000
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;

// 按模型名推断上下文窗口大小
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

// 有效上下文窗口 = 总窗口 - 预留给 summary 的部分
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
    warning: boolean; // 接近 auto-compact 阈值
    critical: boolean; // 已超过 auto-compact 阈值
}

// 根据 token 数算警告状态
// warning/critical 使用固定 token buffer，比百分比更贴近真实窗口余量。
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
