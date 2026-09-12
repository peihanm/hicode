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

/** Simple names and a|b match exactly; compile regex only when metacharacters are present. The query is bounded event metadata, not command output or large user text. */
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
