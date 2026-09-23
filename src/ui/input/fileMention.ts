import type {InputBoundaryState, InputAtomicRange} from "./MultilineTextInput.js";

interface FileMention {start: number; end: number; query: string;}

export function fileMentionAt(state: InputBoundaryState, ranges: readonly InputAtomicRange[] = []): FileMention | undefined {
    const {value, cursorOffset: cursor} = state;
    if (ranges.some(range => cursor >= range.start && cursor <= range.end)) return undefined;
    const before = value.slice(0, cursor);
    const match = /(?:^|[^A-Za-z0-9_./%+@-])@([^\s@"'`<>]*)$/.exec(before);
    if (!match) return undefined;
    const start = cursor - match[1]!.length - 1;
    let end = cursor;
    while (end < value.length && !/[\s@"'`<>]/.test(value[end]!)) end++;
    return {start, end, query: match[1]!};
}

export function completeFileMention(state: InputBoundaryState, mention: FileMention, path: string): InputBoundaryState {
    const quoted = /[\s"'`]/.test(path) ? JSON.stringify(path) : path;
    const separator = /^\s/.test(state.value.slice(mention.end)) ? "" : " ";
    return {value: state.value.slice(0, mention.start) + quoted + separator + state.value.slice(mention.end),
        cursorOffset: mention.start + quoted.length + (separator ? 1 : 0)};
}
