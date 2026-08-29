// 字符串匹配辅助：引号归一化 + 模糊查找
// LLM 经常把 ASCII " 写成 Unicode " "，把 ' 写成 ' ’
// 归一化后匹配，能显著提升 edit_file 成功率（参考 claude-code findActualString）

const QUOTE_MAP: Record<string, string> = {
    "\u201C": '"', // "
    "\u201D": '"', // "
    "\u2018": "'", // '
    "\u2019": "'", // '
};

function normalize(s: string): string {
    return s.replace(/[\u201C\u201D\u2018\u2019]/g, (c) => QUOTE_MAP[c] ?? c);
}

export interface MatchResult {
    index: number; // 匹配起点（-1 = 未匹配）
    actualString: string; // 文件里真实的字符串（可能是引号变体）
}

// 在 content 里查找 target 的位置，支持引号归一化模糊匹配
// 返回 index 和文件里真实的字符串（用于错误提示时显示真实内容）
export function findActualString(
    content: string,
    target: string
): MatchResult {
    // 先精确匹配
    const exact = content.indexOf(target);
    if (exact !== -1) {
        return {index: exact, actualString: target};
    }

    // 模糊匹配：归一化后比较
    const normalizedContent = normalize(content);
    const normalizedTarget = normalize(target);
    const fuzzy = normalizedContent.indexOf(normalizedTarget);
    if (fuzzy !== -1) {
        // 从原 content 切出真实字符串（长度 = target 长度）
        return {
            index: fuzzy,
            actualString: content.slice(fuzzy, fuzzy + target.length),
        };
    }

    return {index: -1, actualString: ""};
}

// 用于计数所有匹配位置
export function countOccurrences(content: string, target: string): number {
    const {index} = findActualString(content, target);
    if (index === -1) return 0;

    // 归一化后用 split 计数
    const norm = normalize(content);
    const normTarget = normalize(target);
    return norm.split(normTarget).length - 1;
}
