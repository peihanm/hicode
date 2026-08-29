import type {ReactNode} from "react";
import {Box, Text} from "ink";
import stringWidth from "string-width";
import {COLORS} from "../theme.js";

type MarkdownBlock =
    | {type: "blank"}
    | {type: "heading"; level: number; text: string}
    | {type: "paragraph"; text: string}
    | {type: "bullet"; indent: string; marker: string; text: string}
    | {type: "code"; lines: string[]}
    | {type: "table"; rows: string[][]};

function tableCells(line: string): string[] {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
    if (!line.includes("|")) return false;
    const cells = tableCells(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdown(value: string): MarkdownBlock[] {
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    const blocks: MarkdownBlock[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (/^\s*```/.test(line)) {
            const code: string[] = [];
            index += 1;
            while (index < lines.length && !/^\s*```/.test(lines[index] ?? "")) {
                code.push(lines[index] ?? "");
                index += 1;
            }
            blocks.push({type: "code", lines: code});
            continue;
        }
        if (
            line.includes("|") &&
            index + 1 < lines.length &&
            isTableDivider(lines[index + 1] ?? "")
        ) {
            const rows = [tableCells(line)];
            index += 2;
            while (index < lines.length && (lines[index] ?? "").includes("|")) {
                rows.push(tableCells(lines[index] ?? ""));
                index += 1;
            }
            index -= 1;
            blocks.push({type: "table", rows});
            continue;
        }
        const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
        if (heading) {
            blocks.push({
                type: "heading",
                level: heading[1]!.length,
                text: heading[2]!,
            });
            continue;
        }
        const bullet = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
        if (bullet) {
            blocks.push({
                type: "bullet",
                indent: bullet[1]!,
                marker: /^\d/.test(bullet[2]!) ? bullet[2]! : "•",
                text: bullet[3]!,
            });
            continue;
        }
        if (!line.trim()) {
            blocks.push({type: "blank"});
            continue;
        }
        blocks.push({type: "paragraph", text: line});
    }
    return blocks;
}

function inlineMarkdown(value: string): ReactNode[] {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+]\([^)\n]+\))/g;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    for (const match of value.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (start > cursor) nodes.push(value.slice(cursor, start));
        const token = match[0];
        if (token.startsWith("`")) {
            nodes.push(
                <Text key={`${start}:code`} color={COLORS.toolName}>
                    {token.slice(1, -1)}
                </Text>
            );
        } else if (token.startsWith("**") || token.startsWith("__")) {
            nodes.push(
                <Text key={`${start}:bold`} bold>
                    {token.slice(2, -2)}
                </Text>
            );
        } else {
            const link = token.match(/^\[([^\]]+)]\(([^)]+)\)$/)!;
            nodes.push(
                <Text key={`${start}:link`}>
                    <Text color={COLORS.accent} underline>{link[1]}</Text>
                    <Text color={COLORS.dim}> ({link[2]})</Text>
                </Text>
            );
        }
        cursor = start + token.length;
    }
    if (cursor < value.length) nodes.push(value.slice(cursor));
    return nodes;
}

function truncateDisplay(value: string, width: number): string {
    if (stringWidth(value) <= width) return value;
    const limit = Math.max(1, width - 1);
    let result = "";
    let used = 0;
    for (const {segment} of new Intl.Segmenter(undefined, {
        granularity: "grapheme",
    }).segment(value)) {
        const next = stringWidth(segment);
        if (used + next > limit) break;
        result += segment;
        used += next;
    }
    return `${result.trimEnd()}…`;
}

function tableColumnWidths(rows: readonly string[][], width: number): number[] {
    const columns = Math.max(...rows.map((row) => row.length), 1);
    const gapWidth = Math.max(0, columns - 1) * 2;
    const available = Math.max(columns * 3, width - gapWidth);
    const widths = Array.from({length: columns}, (_, column) =>
        Math.max(3, ...rows.map((row) => stringWidth(row[column] ?? "")))
    );
    while (widths.reduce((sum, item) => sum + item, 0) > available) {
        let widest = -1;
        for (let index = 0; index < widths.length; index += 1) {
            if (widths[index]! > 3 && (widest < 0 || widths[index]! > widths[widest]!)) {
                widest = index;
            }
        }
        if (widest < 0) break;
        widths[widest] -= 1;
    }
    return widths;
}

function MarkdownTable({rows, width}: {rows: string[][]; width: number}) {
    const widths = tableColumnWidths(rows, width);
    return (
        <Box flexDirection="column">
            {rows.map((row, rowIndex) => (
                <Box key={`row:${rowIndex}`}>
                    {widths.map((columnWidth, columnIndex) => (
                        <Box
                            key={`cell:${columnIndex}`}
                            width={columnWidth}
                            marginRight={columnIndex + 1 < widths.length ? 2 : 0}
                        >
                            <Text bold={rowIndex === 0}>
                                {truncateDisplay(row[columnIndex] ?? "", columnWidth)}
                            </Text>
                        </Box>
                    ))}
                </Box>
            ))}
        </Box>
    );
}

export function TerminalMarkdown({value, width}: {value: string; width: number}) {
    const blocks = parseMarkdown(value);
    return (
        <Box flexDirection="column" flexGrow={1}>
            {blocks.map((block, index) => {
                if (block.type === "blank") {
                    return <Text key={index}> </Text>;
                }
                if (block.type === "heading") {
                    return (
                        <Text
                            key={index}
                            bold
                            color={block.level <= 2 ? COLORS.accent : undefined}
                        >
                            {inlineMarkdown(block.text)}
                        </Text>
                    );
                }
                if (block.type === "bullet") {
                    return (
                        <Box key={index}>
                            <Text>{block.indent}{block.marker} </Text>
                            <Text>{inlineMarkdown(block.text)}</Text>
                        </Box>
                    );
                }
                if (block.type === "code") {
                    return (
                        <Box key={index} flexDirection="column" marginLeft={1}>
                            {block.lines.map((line, lineIndex) => (
                                <Text key={lineIndex} color={COLORS.toolResult}>
                                    {line || " "}
                                </Text>
                            ))}
                        </Box>
                    );
                }
                if (block.type === "table") {
                    return <MarkdownTable key={index} rows={block.rows} width={width}/>;
                }
                return <Text key={index}>{inlineMarkdown(block.text)}</Text>;
            })}
        </Box>
    );
}
