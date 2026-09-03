// 上下文窗口配置 + token 阈值状态
// 参考 claude-code src/utils/context.ts（getContextWindowForModel）
// 和 src/services/compact/autoCompact.ts:93-145（calculateTokenWarningState）

// 预留给压缩时 summary 输出的 token（claude-code COMPACT_MAX_OUTPUT_TOKENS = 20_000）
const RESERVED_FOR_SUMMARY = 20_000;

// 未知模型使用保守默认值；已知模型在这里明确声明窗口。
const DEFAULT_CONTEXT_WINDOW = 128_000;

// Auto-Compact 阈值参考 claude-code services/compact/autoCompact.ts：
// effectiveWindow = contextWindow - summaryReserve
// autoCompactThreshold = effectiveWindow - 13_000
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;

// 按模型名推断上下文窗口大小
function getContextWindowForModel(model: string): number {
    const normalizedModel = model.toLowerCase();
    if (normalizedModel.includes("glm-5.2")) return 1_000_000;
    if (normalizedModel.includes("glm")) return 128_000;
    if (normalizedModel.startsWith("deepseek-v4-")) return 1_000_000;
    if (
        normalizedModel.startsWith("qwen3.8-flash") ||
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
function resolveContextWindow(model: string, reportedWindow?: number): number {
    if (
        reportedWindow !== undefined &&
        Number.isSafeInteger(reportedWindow) &&
        reportedWindow > 0
    ) {
        return reportedWindow;
    }
    return getContextWindowForModel(model);
}

function getEffectiveContextWindow(model: string, reportedWindow?: number): number {
    return Math.max(
        1,
        resolveContextWindow(model, reportedWindow) - RESERVED_FOR_SUMMARY
    );
}

export function getAutoCompactThreshold(
    model: string,
    reportedWindow?: number
): number {
    return Math.max(
        1,
        getEffectiveContextWindow(model, reportedWindow) - AUTOCOMPACT_BUFFER_TOKENS
    );
}

function getTokenWarningThreshold(model: string, reportedWindow?: number): number {
    return Math.max(
        1,
        getAutoCompactThreshold(model, reportedWindow) - WARNING_THRESHOLD_BUFFER_TOKENS
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
    reportedWindow?: number
): TokenWarningState {
    const effective = getEffectiveContextWindow(model, reportedWindow);
    const autoCompactThreshold = getAutoCompactThreshold(model, reportedWindow);
    const percentUsed = Math.min(1, tokenCount / effective);
    const critical = tokenCount >= autoCompactThreshold;
    return {
        percentUsed,
        warning: tokenCount >= getTokenWarningThreshold(model, reportedWindow),
        critical,
    };
}
