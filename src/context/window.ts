// 上下文窗口配置 + token 阈值状态
// 参考 claude-code src/utils/context.ts（getContextWindowForModel）
// 和 src/services/compact/autoCompact.ts:93-145（calculateTokenWarningState）

// 预留给压缩时 summary 输出的 token（claude-code COMPACT_MAX_OUTPUT_TOKENS = 20_000）
export const RESERVED_FOR_SUMMARY = 20_000;

// 未知模型使用保守默认值；GLM-5.2 在模型映射中明确使用 1M。
// 中转站接入新模型时可用 CONTEXT_WINDOW 覆盖。
const DEFAULT_CONTEXT_WINDOW = 128_000;

// Auto-Compact 阈值参考 claude-code services/compact/autoCompact.ts：
// effectiveWindow = contextWindow - summaryReserve
// autoCompactThreshold = effectiveWindow - 13_000
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
const BLOCKING_BUFFER_TOKENS = 3_000;

// 按模型名推断上下文窗口大小
export function getContextWindowForModel(model: string): number {
    // env 覆盖（测试/调试用）
    const envOverride = process.env.CONTEXT_WINDOW;
    if (envOverride) {
        const n = Number(envOverride);
        if (!Number.isNaN(n)) return n;
    }

    const normalizedModel = model.toLowerCase();
    if (normalizedModel.includes("glm-5.2")) return 1_000_000;
    if (normalizedModel.includes("glm")) return 128_000;
    if (normalizedModel.startsWith("deepseek-v4-")) return 1_000_000;
    if (
        normalizedModel.startsWith("qwen3.7-plus") ||
        normalizedModel.startsWith("qwen3.7-max") ||
        normalizedModel.startsWith("qwen3.6-plus") ||
        normalizedModel.startsWith("qwen3.6-flash") ||
        normalizedModel.startsWith("qwen3-coder-plus")
    ) {
        return 1_000_000;
    }
    if (normalizedModel.startsWith("qwen3-coder-next")) return 262_144;
    return DEFAULT_CONTEXT_WINDOW;
}

// 有效上下文窗口 = 总窗口 - 预留给 summary 的部分
export function getEffectiveContextWindow(model: string): number {
    return Math.max(1, getContextWindowForModel(model) - RESERVED_FOR_SUMMARY);
}

export function getAutoCompactThreshold(model: string): number {
    const envOverride = process.env.AUTO_COMPACT_THRESHOLD;
    if (envOverride) {
        const n = Number(envOverride);
        if (!Number.isNaN(n) && n > 0) return n;
    }
    return Math.max(1, getEffectiveContextWindow(model) - AUTOCOMPACT_BUFFER_TOKENS);
}

function getTokenWarningThreshold(model: string): number {
    return Math.max(1, getAutoCompactThreshold(model) - WARNING_THRESHOLD_BUFFER_TOKENS);
}

function getBlockingLimit(model: string): number {
    return Math.max(1, getEffectiveContextWindow(model) - BLOCKING_BUFFER_TOKENS);
}

export interface TokenWarningState {
    percentUsed: number; // 0-1
    percentLeft: number; // 0-1，相对 auto-compact 阈值
    warning: boolean; // 接近 auto-compact 阈值
    critical: boolean; // 已超过 auto-compact 阈值
    autoCompact: boolean;
    blocking: boolean;
}

// 根据 token 数算警告状态
// warning/autoCompact 使用固定 token buffer，比百分比更贴近 claude-code 的策略。
export function getTokenWarningState(
    tokenCount: number,
    model: string
): TokenWarningState {
    const effective = getEffectiveContextWindow(model);
    const autoCompactThreshold = getAutoCompactThreshold(model);
    const percentUsed = Math.min(1, tokenCount / effective);
    const percentLeft = Math.max(
        0,
        (autoCompactThreshold - tokenCount) / autoCompactThreshold
    );
    const autoCompact = tokenCount >= autoCompactThreshold;
    return {
        percentUsed,
        percentLeft,
        warning: tokenCount >= getTokenWarningThreshold(model),
        critical: autoCompact,
        autoCompact,
        blocking: tokenCount >= getBlockingLimit(model),
    };
}
