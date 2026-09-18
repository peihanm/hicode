import stringWidth from "string-width";

/** Small screen model for Ink's output protocol, including erase, scrolling and saved cursor. */
export class TerminalScreen {
    private grid: string[][];
    private x = 0;
    private y = 0;
    private saved = {x: 0, y: 0};
    constructor(readonly columns: number, readonly rows: number) {
        this.grid = Array.from({length: rows}, () => []);
    }
    private lineFeed(): void {
        this.x = 0;
        if (++this.y >= this.rows) {
            this.grid.shift(); this.grid.push([]); this.y = this.rows - 1;
        }
    }
    write(value: string): void {
        const tokens = value.match(/\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[78]|[^\x1b]/gu) ?? [];
        for (const token of tokens) {
            if (token === "\x1b7") {this.saved = {x: this.x, y: this.y}; continue;}
            if (token === "\x1b8") {this.x = this.saved.x; this.y = this.saved.y; continue;}
            if (token.startsWith("\x1b]")) continue;
            if (token.startsWith("\x1b[")) {
                const action = token.at(-1);
                const args = token.slice(2, -1).split(";").map(Number);
                const count = args[0] || 1;
                if (action === "A") this.y = Math.max(0, this.y - count);
                else if (action === "B") this.y = Math.min(this.rows - 1, this.y + count);
                else if (action === "G") this.x = Math.min(this.columns - 1, count - 1);
                else if (action === "H") {this.y = Math.min(this.rows - 1, count - 1); this.x = Math.min(this.columns - 1, (args[1] || 1) - 1);}
                else if (action === "K" && args[0] === 2) this.grid[this.y] = [];
                else if (action === "J" && args[0] === 2) this.grid = Array.from({length: this.rows}, () => []);
                else if (!["m", "h", "l", "J"].includes(action ?? "")) throw new Error(`Unsupported terminal sequence: ${JSON.stringify(token)}`);
                continue;
            }
            if (token === "\n") {this.lineFeed(); continue;}
            if (token === "\r") {this.x = 0; continue;}
            const width = stringWidth(token);
            if (!width) continue;
            if (this.x + width > this.columns) this.lineFeed();
            const line = this.grid[this.y]!;
            while (line.length < this.x) line.push(" ");
            line[this.x] = token;
            for (let cell = 1; cell < width; cell++) line[this.x + cell] = "";
            this.x += width;
        }
    }
    get lines(): string[] {return this.grid.map(line => line.join(""));}
    get cursor(): {x: number; y: number} {return {x: this.x, y: this.y};}
}
