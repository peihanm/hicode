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
            if (
                blocks.length > 0 &&
                blocks.at(-1)?.type !== "blank"
            ) {
                blocks.push({type: "blank"});
            }
            continue;
        }
        blocks.push({type: "paragraph", text: line});
    }
    if (blocks.at(-1)?.type === "blank") blocks.pop();
    return blocks;
}

interface MarkdownSpan {text: string; bold?: boolean; color?: string; underline?: boolean}

function inlineSpans(value: string): MarkdownSpan[] {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+]\([^)\n]+\))/g;
    const spans: MarkdownSpan[] = [];
    let cursor = 0;
    for (const match of value.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (start > cursor) spans.push({text: value.slice(cursor, start)});
        const token = match[0];
        if (token.startsWith("`")) spans.push({text: token.slice(1, -1), color: COLORS.toolName});
        else if (token.startsWith("**") || token.startsWith("__")) spans.push({text: token.slice(2, -2), bold: true});
        else {
            const link = token.match(/^\[([^\]]+)]\(([^)]+)\)$/)!;
            spans.push({text: link[1]!, color: COLORS.accent, underline: true}, {text: ` (${link[2]})`, color: COLORS.dim});
        }
        cursor = start + token.length;
    }
    if (cursor < value.length) spans.push({text: value.slice(cursor)});
    return spans;
}

function renderSpans(spans: readonly MarkdownSpan[]): ReactNode {
    return spans.map(({text, ...style}, index) => <Text key={index} {...style}>{text}</Text>);
}

function inlineMarkdown(value: string): ReactNode {return renderSpans(inlineSpans(value));}

function wrapSpans(spans: readonly MarkdownSpan[], width: number, code = false): MarkdownSpan[][] {
    const rows: MarkdownSpan[][] = [];
    const columns = Math.max(1, width);
    const segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});
    let row: MarkdownSpan[] = [];
    let used = 0;
    const flush = () => {rows.push(row); row = []; used = 0;};
    for (const span of spans) {
        const words = code ? [span.text] : span.text.split(/(\s+)/);
        for (const word of words) {
            if (!code && used && word.trim() && stringWidth(word) <= columns && used + stringWidth(word) > columns) flush();
            for (const {segment} of segmenter.segment(word.replace(/\t/g, "    "))) {
                const size = stringWidth(segment);
                if (used && used + size > columns) flush();
                if (!code && !used && segment === " " && word.trim() === "") continue;
                const last = row.at(-1);
                if (last && last.bold === span.bold && last.color === span.color && last.underline === span.underline) last.text += segment;
                else row.push({...span, text: segment});
                used += size;
            }
        }
    }
    flush();
    return rows;
}

/** Parse before wrapping and slicing: styles and code fences survive viewport boundaries. */
export function layoutTerminalMarkdown(value: string, width: number, markdown = true): ReactNode[] {
    const lines: ReactNode[] = [];
    const wrap = (spans: readonly MarkdownSpan[], code = false) => {
        lines.push(...wrapSpans(spans, width, code).map(renderSpans));
    };
    if (!markdown) {
        for (const line of value.split("\n")) wrap([{text: line}], true);
        return lines;
    }
    for (const block of parseMarkdown(value)) {
        if (block.type === "blank") lines.push(" ");
        else if (block.type === "code") for (const line of block.lines) wrap([{text: line || " ", color: COLORS.toolResult}], true);
        else if (block.type === "table") lines.push(...layoutTable(block.rows, width).map(renderSpans));
        else {
            const spans = inlineSpans(block.text);
            if (block.type === "heading") for (const span of spans) {span.bold = true; span.color ??= COLORS.accent;}
            if (block.type === "bullet") spans.unshift({text: `${block.indent}${block.marker} `});
            wrap(spans);
        }
    }
    return lines.length ? lines : [" "];
}

function tableColumnWidths(rows: readonly string[][], width: number): number[] {
    const columns = Math.max(...rows.map((row) => row.length), 1);
    const gapWidth = Math.max(0, columns - 1) * 2;
    const available = Math.max(columns * 3, width - gapWidth);
    const widths = Array.from({length: columns}, (_, column) =>
        Math.max(3, ...rows.map((row) => stringWidth(inlineSpans(row[column] ?? "").map(span => span.text).join(""))))
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

function layoutTable(rows: readonly string[][], width: number): MarkdownSpan[][] {
    const widths = tableColumnWidths(rows, width);
    const lines: MarkdownSpan[][] = [];
    if (width < widths.length * 18 + (widths.length - 1) * 2) {
        const header = rows[0] ?? [];
        for (const [index, row] of rows.slice(1).entries()) {
            if (index) lines.push([{text: " "}]);
            for (let column = 0; column < widths.length; column++) {
                const label = header[column] || `Column ${column + 1}`;
                lines.push(...wrapSpans([
                    ...inlineSpans(label).map(span => ({...span, bold: true})),
                    {text: ": "}, ...inlineSpans(row[column] ?? ""),
                ], width));
            }
        }
        if (rows.length === 1) lines.push(...wrapSpans(inlineSpans(header.join(" · ")), width));
        return lines;
    }
    for (const [index, row] of rows.entries()) {
        const cells = widths.map((size, column) => wrapSpans(inlineSpans(row[column] ?? "").map(span =>
            index === 0 ? {...span, bold: true} : span), size));
        const height = Math.max(...cells.map(cell => cell.length));
        for (let line = 0; line < height; line++) {
            const spans: MarkdownSpan[] = [];
            cells.forEach((cell, column) => {
                const content = cell[line] ?? [];
                spans.push(...content);
                if (column < cells.length - 1) spans.push({text: " ".repeat(Math.max(0,
                    widths[column]! - stringWidth(content.map(span => span.text).join(""))) + 2)});
            });
            lines.push(spans);
        }
    }
    return lines;
}

function MarkdownTable({rows, width}: {rows: string[][]; width: number}) {
    return <Box flexDirection="column">
        {layoutTable(rows, width).map((line, index) => <Text key={index}>{renderSpans(line)}</Text>)}
    </Box>;
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
