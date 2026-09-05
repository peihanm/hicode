export interface MatchSpan {
    start: number;
    end: number;
}

function normalizeQuotes(value: string): string {
    return value.replace(/[\u201C\u201D]/g, '\"').replace(/[\u2018\u2019]/g, "'");
}

/** Exact matches take precedence; normalization preserves UTF-16 offsets. */
export function findMatches(content: string, target: string): MatchSpan[] {
    if (!target) return [];
    const exact = content.includes(target);
    const haystack = exact ? content : normalizeQuotes(content);
    const needle = exact ? target : normalizeQuotes(target);
    const spans: MatchSpan[] = [];
    let start = haystack.indexOf(needle);
    while (start >= 0) {
        spans.push({start, end: start + needle.length});
        start = haystack.indexOf(needle, start + needle.length);
    }
    return spans;
}
