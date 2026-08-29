// 通配符匹配
// 参考 claude-code src/utils/permissions/shellRuleMatching.ts
//
// 两种模式：
// 1. "prefix:*" 老语法（prefix matching）
//    "git add:*" → 匹配以 "git add" 开头的命令（包括 "git add" 本身）
// 2. "*" 通配符（wildcard matching）
//    "*" → 匹配任意
//    "git *" → 匹配 "git" 开头 + 空格 + 任意
//
// 算法：
// - 如果 pattern 以 :* 结尾 → 提取前缀，判断 input 是否以 prefix 开头
// - 否则用通配符正则匹配

export function matchPattern(pattern: string, input: string): boolean {
    // 1. 老语法 prefix:* → 前缀匹配
    const prefixMatch = pattern.match(/^(.+):\*$/);
    if (prefixMatch) {
        const prefix = prefixMatch[1];
        // input 以 prefix 开头，或者 input === prefix
        return input === prefix || input.startsWith(prefix + " ");
    }

    // 2. 通配符 * → 正则匹配
    // 用占位符防止 * 被转义
    const PLACEHOLDER = "\u0000";
    const step1 = pattern.replace(/\*/g, PLACEHOLDER);
    const step2 = step1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regexStr = step2.replace(new RegExp(PLACEHOLDER, "g"), ".*");
    return new RegExp(`^${regexStr}$`, "s").test(input);
}
