const SIMPLE_ALTERNATIVES = /^[A-Za-z0-9_:-]+(?:\|[A-Za-z0-9_:-]+)*$/;

export function isValidHookMatcher(matcher: string): boolean {
    if (matcher === "*" || SIMPLE_ALTERNATIVES.test(matcher)) return true;
    try {
        new RegExp(matcher);
        return true;
    } catch {
        return false;
    }
}

/**
 * 简单名称和 `a|b` 使用精确匹配；包含正则元字符时才编译为正则。
 * query 是有界的事件元数据，而不是命令输出或用户大文本。
 */
export function matchesHookMatcher(
    query: string | undefined,
    matcher: string | undefined
): boolean {
    if (query === undefined) return true;
    if (!matcher || matcher === "*") return true;
    if (SIMPLE_ALTERNATIVES.test(matcher)) {
        return matcher.split("|").includes(query);
    }
    if (!isValidHookMatcher(matcher)) return false;
    return new RegExp(matcher).test(query);
}
