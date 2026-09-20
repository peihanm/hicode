import {useEffect, useMemo, useRef, useState} from "react";
import {Box, Text, Transform, useInput, type Key} from "ink";
import stringWidth from "string-width";
import {COLORS, SYMBOLS} from "../theme.js";
import {useTerminalCursorTransform} from "./terminalCursorContext.js";

export interface InputRow {
    start: number;
    end: number;
    text: string;
}

export interface InputBoundaryState {
    value: string;
    cursorOffset: number;
}

export type InputBoundaryReplacement = InputBoundaryState;

export interface InputAtomicRange {
    id: number;
    start: number;
    end: number;
}

const segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});

function graphemes(value: string): Array<{ segment: string; index: number }> {
    return Array.from(segmenter.segment(value), ({segment, index}) => ({
        segment,
        index,
    }));
}

export function layoutInputRows(value: string, columns: number): InputRow[] {
    const width = Math.max(1, columns);
    const rows: InputRow[] = [];
    let start = 0;
    let text = "";
    let visualWidth = 0;

    for (const {segment, index} of graphemes(value)) {
        if (segment === "\n" || segment === "\r\n" || segment === "\r") {
            rows.push({start, end: index, text});
            start = index + segment.length;
            text = "";
            visualWidth = 0;
            continue;
        }
        const nextWidth = stringWidth(segment);
        if (text && visualWidth + nextWidth > width) {
            rows.push({start, end: index, text});
            start = index;
            text = "";
            visualWidth = 0;
        }
        text += segment;
        visualWidth += nextWidth;
    }
    rows.push({start, end: value.length, text});
    return rows;
}

function rowForCursor(rows: InputRow[], cursor: number): number {
    let found = 0;
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        if (cursor >= row.start && cursor <= row.end) found = index;
    }
    return found;
}

function previousOffset(value: string, cursor: number): number {
    let previous = 0;
    for (const item of graphemes(value)) {
        if (item.index >= cursor) break;
        previous = item.index;
    }
    return previous;
}

function nextOffset(value: string, cursor: number): number {
    for (const item of graphemes(value)) {
        if (item.index > cursor) return item.index;
    }
    return value.length;
}

function offsetAtColumn(value: string, row: InputRow, column: number): number {
    let width = 0;
    for (const item of graphemes(value.slice(row.start, row.end))) {
        const next = width + stringWidth(item.segment);
        if (next > column) return row.start + item.index;
        width = next;
    }
    return row.end;
}

function moveVertically(
    value: string,
    cursor: number,
    rows: InputRow[],
    direction: -1 | 1
): number {
    const currentIndex = rowForCursor(rows, cursor);
    const target = rows[currentIndex + direction];
    const current = rows[currentIndex]!;
    if (!target) return cursor;
    const column = stringWidth(value.slice(current.start, cursor));
    return offsetAtColumn(value, target, column);
}

function normalizeInsertedText(input: string): string {
    return input.replace(/\r\n?/g, "\n");
}

function containingAtomicRange(
    ranges: readonly InputAtomicRange[],
    cursor: number,
    includeEnd: boolean
): InputAtomicRange | undefined {
    return ranges.find((range) =>
        includeEnd
            ? cursor > range.start && cursor <= range.end
            : cursor >= range.start && cursor < range.end
    );
}

export function MultilineTextInput({
                                       value,
                                       onChange,
                                       onSubmit,
                                       width,
                                       placeholder,
                                       leadingContent = "",
                                       onBackspaceAtStart,
                                       maxRows = 10,
                                       handleVerticalNavigation = true,
                                       onVerticalBoundary,
                                       atomicRanges = [],
                                       onAtomicRangeDelete,
                                       onInsertText,
                                       onInputBoundary,
                                       onEditStateChange,
                                       onKey,
                                   }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: (value: string) => void;
    width: number;
    placeholder?: string;
    leadingContent?: string;
    onBackspaceAtStart?: () => void;
    maxRows?: number;
    handleVerticalNavigation?: boolean;
    onVerticalBoundary?: (
        direction: -1 | 1,
        state: InputBoundaryState
    ) => InputBoundaryReplacement | undefined;
    atomicRanges?: readonly InputAtomicRange[];
    onAtomicRangeDelete?: (range: InputAtomicRange) => void;
    onInsertText?: (
        text: string,
        state: InputBoundaryState
    ) => InputBoundaryReplacement | undefined;
    onInputBoundary?: () => void;
    onEditStateChange?: (state: InputBoundaryState) => void;
    onKey?: (input: string, key: Key, state: InputBoundaryState) => true | InputBoundaryReplacement | undefined;
}) {
    const [cursor, setCursor] = useState(value.length);
    const cursorRef = useRef(value.length);
    const expectedValueRef = useRef(value);
    const moveCursor = (offset: number) => {
        cursorRef.current = offset;
        setCursor(offset);
        onEditStateChange?.({value: expectedValueRef.current, cursorOffset: offset});
    };
    const safeCursor = Math.min(cursor, value.length);
    // Attachments are a display prefix. Text offsets and submitted values never contain their labels.
    const displayedValue = leadingContent + value;
    const displayedCursor = leadingContent.length + safeCursor;
    const contentWidth = Math.max(8, width - 3);
    const rows = useMemo(
        () => layoutInputRows(displayedValue, contentWidth),
        [contentWidth, displayedValue]
    );
    const cursorRow = rowForCursor(rows, displayedCursor);
    const firstVisible = Math.max(
        0,
        Math.min(cursorRow - maxRows + 1, rows.length - maxRows)
    );
    const visibleRows = rows.slice(firstVisible, firstVisible + maxRows);
    const transformCursor = useTerminalCursorTransform();

    useEffect(() => {
        if (value !== expectedValueRef.current) {
            expectedValueRef.current = value;
            moveCursor(value.length);
        } else {
            onEditStateChange?.({value: expectedValueRef.current, cursorOffset: cursorRef.current});
        }
    }, [value]);

    const applyReplacement = (replacement: InputBoundaryReplacement) => {
        const nextCursor = Math.max(
            0,
            Math.min(replacement.cursorOffset, replacement.value.length)
        );
        expectedValueRef.current = replacement.value;
        onChange(replacement.value);
        moveCursor(nextCursor);
    };

    const insert = (text: string) => {
        const value = expectedValueRef.current;
        const safeCursor = Math.min(cursorRef.current, value.length);
        const normalized = normalizeInsertedText(text);
        const replacement = onInsertText?.(text, {
            value,
            cursorOffset: safeCursor,
        });
        if (replacement) {
            applyReplacement(replacement);
            return;
        }
        const nextValue =
            value.slice(0, safeCursor) + normalized + value.slice(safeCursor);
        applyReplacement({
            value: nextValue,
            cursorOffset: safeCursor + normalized.length,
        });
    };

    useInput((input, key) => {
        // Multiple stdin chunks can arrive before React commits the previous insertion.
        const value = expectedValueRef.current;
        const safeCursor = Math.min(cursorRef.current, value.length);
        const consumed = onKey?.(input, key, {value, cursorOffset: safeCursor});
        if (consumed) {
            onInputBoundary?.();
            if (consumed !== true) applyReplacement(consumed);
            return;
        }
        if (key.return || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow ||
            key.backspace || key.delete || key.tab || key.escape || key.ctrl || key.meta ||
            key.pageDown || key.pageUp || !input) onInputBoundary?.();
        if (key.return) {
            if (key.shift) insert("\n");
            else onSubmit(value);
            return;
        }
        if (key.leftArrow) {
            const range = containingAtomicRange(atomicRanges, safeCursor, true);
            moveCursor(range?.start ?? previousOffset(value, safeCursor));
            return;
        }
        if (key.rightArrow) {
            const range = containingAtomicRange(atomicRanges, safeCursor, false);
            moveCursor(range?.end ?? nextOffset(value, safeCursor));
            return;
        }
        if (key.upArrow || key.downArrow) {
            if (handleVerticalNavigation) {
                const visualValue = leadingContent + value;
                const visualCursor = leadingContent.length + safeCursor;
                const rows = layoutInputRows(visualValue, contentWidth);
                const direction = key.upArrow ? -1 : 1;
                const currentRow = rowForCursor(rows, visualCursor);
                const targetRow = rows[currentRow + direction];
                if (targetRow && targetRow.end >= leadingContent.length) {
                    const nextCursor = Math.max(0, moveVertically(
                        visualValue,
                        visualCursor,
                        rows,
                        direction
                    ) - leadingContent.length);
                    const range = containingAtomicRange(
                        atomicRanges,
                        nextCursor,
                        false
                    );
                    moveCursor(
                        range
                            ? direction === -1 ? range.start : range.end
                            : nextCursor
                    );
                } else {
                    const replacement = onVerticalBoundary?.(direction, {
                        value,
                        cursorOffset: safeCursor,
                    });
                    if (replacement) {
                        applyReplacement(replacement);
                    }
                }
            }
            return;
        }
        if (key.backspace || key.delete) {
            if (safeCursor === 0) onBackspaceAtStart?.();
            if (safeCursor > 0) {
                const atomicRange = containingAtomicRange(
                    atomicRanges,
                    safeCursor,
                    true
                );
                if (atomicRange) {
                    onAtomicRangeDelete?.(atomicRange);
                    applyReplacement({
                        value:
                            value.slice(0, atomicRange.start) +
                            value.slice(atomicRange.end),
                        cursorOffset: atomicRange.start,
                    });
                    return;
                }
                const previous = previousOffset(value, safeCursor);
                const nextValue = value.slice(0, previous) + value.slice(safeCursor);
                applyReplacement({value: nextValue, cursorOffset: previous});
            }
            return;
        }
        if (
            key.tab ||
            key.escape ||
            key.ctrl ||
            key.meta ||
            key.pageDown ||
            key.pageUp ||
            !input
        ) {
            return;
        }
        insert(input);
    });

    return (
        <Box flexDirection="column">
            {firstVisible > 0 && <Text color={COLORS.dim}> …</Text>}
            {visibleRows.map((row, visibleIndex) => {
                const actualIndex = firstVisible + visibleIndex;
                const hasCursor = actualIndex === cursorRow;
                const cursorInRow = Math.min(Math.max(displayedCursor, row.start), row.end);
                const before = hasCursor ? displayedValue.slice(row.start, cursorInRow) : row.text;
                const cursorEnd = hasCursor
                    ? nextOffset(displayedValue, cursorInRow)
                    : cursorInRow;
                const cursorText =
                    hasCursor && cursorInRow < row.end
                        ? displayedValue.slice(cursorInRow, Math.min(cursorEnd, row.end))
                        : " ";
                const after = hasCursor
                    ? displayedValue.slice(Math.min(cursorEnd, row.end), row.end)
                    : "";
                return (
                    <Box key={`${row.start}-${actualIndex}`}>
                        <Text color={COLORS.prompt} bold>
                            {visibleIndex === 0 ? `${SYMBOLS.prompt} ` : "  "}
                        </Text>
                        <Text>{before}</Text>
                        {hasCursor && (
                            <Transform transform={transformCursor}>
                                <Text inverse>{cursorText}</Text>
                            </Transform>
                        )}
                        <Text>{after}</Text>
                        {hasCursor && !displayedValue && placeholder && (
                            <Text color={COLORS.dim}>{placeholder}</Text>
                        )}
                    </Box>
                );
            })}
            {firstVisible + visibleRows.length < rows.length && (
                <Text color={COLORS.dim}> …</Text>
            )}
        </Box>
    );
}
