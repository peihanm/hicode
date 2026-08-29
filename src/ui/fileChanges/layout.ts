import stringWidth from "string-width";

export function wrapDisplayText(text: string, maxWidth: number): string[] {
    const width = Math.max(1, maxWidth);
    if (text.length === 0) return [""];
    const lines: string[] = [];
    let current = "";
    let currentWidth = 0;
    const graphemes = typeof Intl.Segmenter === "function"
        ? Array.from(
            new Intl.Segmenter(undefined, {granularity: "grapheme"}).segment(text),
            (part) => part.segment
        )
        : Array.from(text);
    for (const char of graphemes) {
        const charWidth = stringWidth(char);
        if (current && currentWidth + charWidth > width) {
            lines.push(current);
            current = "";
            currentWidth = 0;
        }
        current += char;
        currentWidth += charWidth;
    }
    lines.push(current);
    return lines;
}

export function maxDiffLineNumber(
    lines: Array<{ oldLineNumber?: number; newLineNumber?: number }>
): number {
    return Math.max(
        1,
        ...lines.map((line) =>
            Math.max(line.oldLineNumber ?? 0, line.newLineNumber ?? 0)
        )
    );
}
