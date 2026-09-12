// Wildcard matching.
// Based on Claude Code src/utils/permissions/shellRuleMatching.ts.
//
// Two modes:
// 1. prefix:* prefix-rule syntax.
// git add:* matches commands starting with git add, including git add itself.
// 2. * wildcard matching.
// * matches anything.
// git * matches git followed by a space and arbitrary content.
//
// Algorithm:
// If pattern ends in :*, extract the prefix and test the input prefix.
// Otherwise use a wildcard-derived regex.

export function matchPattern(pattern: string, input: string): boolean {
    // 1. prefix:* matches a command prefix.
    const prefixMatch = pattern.match(/^(.+):\*$/);
    if (prefixMatch) {
        const prefix = prefixMatch[1];
        // Input starts with prefix or equals prefix.
        return input === prefix || input.startsWith(prefix + " ");
    }

    // 2. Convert wildcard * to regex matching.
    // Use a placeholder to keep * from being escaped.
    const PLACEHOLDER = "\u0000";
    const step1 = pattern.replace(/\*/g, PLACEHOLDER);
    const step2 = step1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regexStr = step2.replace(new RegExp(PLACEHOLDER, "g"), ".*");
    return new RegExp(`^${regexStr}$`, "s").test(input);
}
