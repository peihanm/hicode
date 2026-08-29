import {stripVTControlCharacters} from "node:util";

export const PASTE_CAPSULE_CHARACTER_THRESHOLD = 800;
export const PASTE_CAPSULE_NEWLINE_THRESHOLD = 2;

export interface PasteCapsule {
    id: number;
    content: string;
    placeholder: string;
}

export interface PasteCapsuleRange {
    id: number;
    start: number;
    end: number;
}

export interface PasteCapsuleState {
    capsules: readonly PasteCapsule[];
    nextId: number;
}

export interface PasteCapsuleInsertion {
    value: string;
    cursorOffset: number;
    state: PasteCapsuleState;
    collapsed: boolean;
}

export const EMPTY_PASTE_CAPSULE_STATE: PasteCapsuleState = {
    capsules: [],
    nextId: 1,
};

function normalizePastedText(value: string): string {
    return stripVTControlCharacters(value)
        .replace(/\r\n?/g, "\n")
        .replaceAll("\t", "    ");
}

function countNewlines(value: string): number {
    return value.split("\n").length - 1;
}

function shouldCollapsePaste(value: string): boolean {
    return value.length > PASTE_CAPSULE_CHARACTER_THRESHOLD ||
        countNewlines(value) > PASTE_CAPSULE_NEWLINE_THRESHOLD;
}

function formatPlaceholder(id: number, content: string): string {
    const newlines = countNewlines(content);
    return newlines > 0
        ? `[Pasted text #${id} +${newlines} lines]`
        : `[Pasted text #${id}]`;
}

export function insertPasteCapsule(
    value: string,
    cursorOffset: number,
    insertedText: string,
    state: PasteCapsuleState
): PasteCapsuleInsertion {
    const normalized = normalizePastedText(insertedText);
    if (!shouldCollapsePaste(normalized)) {
        return {
            value:
                value.slice(0, cursorOffset) +
                normalized +
                value.slice(cursorOffset),
            cursorOffset: cursorOffset + normalized.length,
            state,
            collapsed: false,
        };
    }

    const id = state.nextId;
    const placeholder = formatPlaceholder(id, normalized);
    return {
        value:
            value.slice(0, cursorOffset) +
            placeholder +
            value.slice(cursorOffset),
        cursorOffset: cursorOffset + placeholder.length,
        state: {
            capsules: [...state.capsules, {id, content: normalized, placeholder}],
            nextId: id + 1,
        },
        collapsed: true,
    };
}

export function collapsePromptText(value: string): PasteCapsuleInsertion {
    return insertPasteCapsule(
        "",
        0,
        value,
        EMPTY_PASTE_CAPSULE_STATE
    );
}

export function getPasteCapsuleRanges(
    value: string,
    state: PasteCapsuleState
): PasteCapsuleRange[] {
    const ranges: PasteCapsuleRange[] = [];
    for (const capsule of state.capsules) {
        const start = value.indexOf(capsule.placeholder);
        if (start < 0) continue;
        ranges.push({
            id: capsule.id,
            start,
            end: start + capsule.placeholder.length,
        });
    }
    return ranges.sort((left, right) => left.start - right.start);
}

export function removePasteCapsule(
    state: PasteCapsuleState,
    id: number
): PasteCapsuleState {
    return {
        capsules: state.capsules.filter((capsule) => capsule.id !== id),
        nextId: state.nextId,
    };
}

export function expandPasteCapsules(
    value: string,
    state: PasteCapsuleState
): string {
    let expanded = value;
    for (const capsule of state.capsules) {
        expanded = expanded.replace(capsule.placeholder, capsule.content);
    }
    return expanded;
}

export function expandPasteCapsuleCursor(
    value: string,
    cursorOffset: number,
    state: PasteCapsuleState
): number {
    let expandedOffset = cursorOffset;
    for (const range of getPasteCapsuleRanges(value, state)) {
        if (range.start >= cursorOffset) break;
        const capsule = state.capsules.find((item) => item.id === range.id);
        if (!capsule) continue;
        if (cursorOffset <= range.end) {
            return expandedOffset +
                capsule.content.length -
                (cursorOffset - range.start);
        }
        expandedOffset += capsule.content.length - (range.end - range.start);
    }
    return expandedOffset;
}
