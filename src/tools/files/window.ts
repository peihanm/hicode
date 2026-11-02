const MAX_READ_CHARS = 60_000;
// Reserve space for the range, stop reason and continuation instructions.
const ENVELOPE_CHARS = 512;

/** One bounded page of complete lines, shared by source and saved-output reads. */
export class ReadWindow {
    private readonly lines: string[] = [];
    private usedChars = 0;
    private stopped?: "characters" | "overlong";

    constructor(private readonly prefix: string, private readonly start: number, private readonly limit: number) {
        if (this.bodyBudget < 1) throw new Error("File read header exceeds the output budget");
    }

    private get bodyBudget(): number { return MAX_READ_CHARS - this.prefix.length - ENVELOPE_CHARS; }
    get count(): number { return this.lines.length; }
    private get nextLine(): number { return this.start + this.count; }
    // A single line must fit even when it is the only line on a fresh page.
    get maxLineChars(): number { return this.bodyBudget - String(this.nextLine).padStart(6, " ").length - 2; }

    rejectOverlongLine(): void { this.stopped = "overlong"; }

    append(text: string): boolean {
        if (this.count >= this.limit || this.stopped) return false;
        if (text.length > this.maxLineChars) {
            this.rejectOverlongLine();
            return false;
        }
        const rendered = `${String(this.nextLine).padStart(6, " ")}\t${text}`;
        if (this.usedChars + rendered.length + 1 > this.bodyBudget) {
            this.stopped = "characters";
            return false;
        }
        this.lines.push(rendered);
        this.usedChars += rendered.length + 1;
        return true;
    }

    render(hasMore: boolean, total?: number): {output: string; header: string} {
        const range = this.count ? `${this.start}-${this.nextLine - 1}` : "none";
        const header = `${this.prefix}\nLine range: ${range}${total === undefined ? "" : ` / ${total}`}`;
        const notes: string[] = [];
        if (this.stopped === "overlong") {
            notes.push(`Line ${this.nextLine} exceeds the single-read character budget and was not shown. Use targeted search/extraction (for example Bash rg -o) for this line; repeating the same read will not show it in full. To read later lines, use offset=${this.nextLine + 1}.`);
        } else if (hasMore) {
            notes.push(`${this.stopped === "characters" ? "Character" : "Line"} limit reached. Continue with read_file on the same path, offset=${this.nextLine} (line number).`);
        } else if (!this.count) {
            notes.push(`offset=${this.start} is outside the file line range.`);
        }
        const output = `${header}\n\n${this.lines.join("\n")}${notes.length ? `\n\n${notes.join("\n")}` : ""}`;
        if (output.length > MAX_READ_CHARS) throw new Error("File read exceeded the output budget");
        return {output, header};
    }
}
