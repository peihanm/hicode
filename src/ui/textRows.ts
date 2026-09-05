import stringWidth from "string-width";

/** Wrap plain source for bounded viewports without losing Markdown or long-line tails. */
export function textRows(value: string, width: number): string[] {
    const rows: string[] = [];
    const segmenter = new Intl.Segmenter(undefined, {granularity: "grapheme"});
    for (const line of value.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
        let row = "";
        let columns = 0;
        for (const {segment: char} of segmenter.segment(line)) {
            const size = stringWidth(char);
            if (row && columns + size > width) {rows.push(row); row = ""; columns = 0;}
            row += char;
            columns += size;
        }
        rows.push(row);
    }
    return rows;
}
