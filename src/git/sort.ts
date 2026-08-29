/** Locale-independent ordering for persisted Git paths and metadata. */
export function compareGitText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
