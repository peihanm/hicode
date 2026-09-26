import React, {memo, useMemo} from "react";
import {Box, Text} from "ink";
import stringWidth from "string-width";
import type {DiffHunk, DiffLine} from "../../fileChanges/index.js";
import {COLORS} from "../theme.js";
import {maxDiffLineNumber, wrapDisplayText} from "./layout.js";
import {getWordParts, pairChangedLines} from "./wordDiff.js";

const DEFAULT_MAX_LINES = 120;
const EXPANDED_MAX_LINES = 2_000;

function lineNumber(line: DiffLine): number | undefined {
    return line.type === "remove" ? line.oldLineNumber : line.newLineNumber;
}

function DiffRow({
                     line,
                     pairedLine,
                     numberWidth,
                     width,
                     expanded,
                 }: {
    line: DiffLine;
    pairedLine?: DiffLine;
    numberWidth: number;
    width: number;
    expanded: boolean;
}) {
    const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    const backgroundColor = line.type === "add"
        ? COLORS.diffAddedBackground
        : line.type === "remove"
            ? COLORS.diffRemovedBackground
            : undefined;
    const contentWidth = Math.max(1, width - numberWidth - 3);
    const displayContent = line.content.replaceAll("\t", "  ");
    const maxContentChars = contentWidth * (expanded ? 40 : 10);
    const lineWasTruncated = displayContent.length > maxContentChars;
    const boundedContent = lineWasTruncated
        ? `${displayContent.slice(0, Math.max(0, maxContentChars - 1))}…`
        : displayContent;
    const wrapped = wrapDisplayText(boundedContent, contentWidth);
    const wordParts = !lineWasTruncated && pairedLine && wrapped.length === 1 && line.type !== "context"
        ? getWordParts(
            displayContent,
            pairedLine.content.replaceAll("\t", "  "),
            line.type
        )
        : null;

    return (
        <Box flexDirection="column">
            {wrapped.map((content, index) => {
                const number = index === 0 ? lineNumber(line) : undefined;
                const gutter = number === undefined
                    ? " ".repeat(numberWidth)
                    : String(number).padStart(numberWidth);
                const marker = index === 0 ? prefix : " ";
                const used = numberWidth + 3 + stringWidth(content);
                const padding = " ".repeat(Math.max(0, width - used));
                return (
                    <Text
                        key={`${index}-${content}`}
                        backgroundColor={backgroundColor}
                        color={backgroundColor ? COLORS.diffText
                            : line.type === "add" ? COLORS.diffAdded
                                : line.type === "remove" ? COLORS.diffRemoved : undefined}
                        dimColor={line.type === "context"}
                    >
                        {gutter} {marker} {wordParts && index === 0
                        ? wordParts.map((part, partIndex) => (
                            <Text
                                key={`${partIndex}-${part.value}`}
                                bold={part.changed}
                                backgroundColor={part.changed
                                    ? line.type === "add"
                                        ? COLORS.diffAddedWordBackground
                                        : COLORS.diffRemovedWordBackground
                                    : backgroundColor}
                            >
                                {part.value}
                            </Text>
                        ))
                        : content}{padding}
                    </Text>
                );
            })}
        </Box>
    );
}

export const StructuredDiff = memo(function StructuredDiff({
                                                               hunks,
                                                               width,
                                                               expanded,
                                                               omittedDiffLines = 0,
                                                               defaultMaxLines = DEFAULT_MAX_LINES,
                                                           }: {
    hunks: DiffHunk[];
    width: number;
    expanded: boolean;
    omittedDiffLines?: number;
    defaultMaxLines?: number;
}) {
    const allLines = useMemo(() => hunks.flatMap((hunk) => hunk.lines), [hunks]);
    const numberWidth = String(maxDiffLineNumber(allLines)).length;
    const limit = expanded ? EXPANDED_MAX_LINES : defaultMaxLines;
    let remaining = limit;
    let hidden = omittedDiffLines;

    return (
        <Box flexDirection="column">
            {hunks.map((hunk, hunkIndex) => {
                if (remaining <= 0) {
                    hidden += hunk.lines.length;
                    return null;
                }
                const visibleLines = hunk.lines.slice(0, remaining);
                hidden += hunk.lines.length - visibleLines.length;
                remaining -= visibleLines.length;
                const pairs = pairChangedLines(hunk);
                return (
                    <React.Fragment key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}>
                        {hunkIndex > 0 && <Text dimColor>...</Text>}
                        {visibleLines.map((line, lineIndex) => {
                            const originalIndex = hunk.lines.indexOf(line);
                            const pairedIndex = pairs.get(originalIndex);
                            return (
                                <DiffRow
                                    key={`${line.type}-${line.oldLineNumber ?? ""}-${line.newLineNumber ?? ""}-${lineIndex}`}
                                    line={line}
                                    pairedLine={pairedIndex === undefined ? undefined : hunk.lines[pairedIndex]}
                                    numberWidth={numberWidth}
                                    width={width}
                                    expanded={expanded}
                                />
                            );
                        })}
                    </React.Fragment>
                );
            })}
            {hidden > 0 && (
                <Text dimColor>… {hidden} more diff
                    line{hidden === 1 ? "" : "s"}{expanded ? "" : " · ctrl+o to expand"}</Text>
            )}
        </Box>
    );
});
