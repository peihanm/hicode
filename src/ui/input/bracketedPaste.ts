const START = "\u001b[200~";
const END = "\u001b[201~";

type TerminalInputEvent =
    | {type: "input"; text: string}
    | {type: "paste_start"}
    | {type: "paste"; text: string};

/** Stream chunks are transport boundaries; only the terminal's end marker completes a paste. */
export class BracketedPasteDecoder {
    private pending = "";
    private parts: string[] | undefined;

    get hasPendingKey(): boolean {return !this.parts && this.pending === "\u001b";}

    flushKey(): string {
        if (this.parts) return "";
        const input = this.pending;
        this.pending = "";
        return input;
    }

    push(chunk: string): TerminalInputEvent[] {
        let input = this.pending + chunk;
        this.pending = "";
        const events: TerminalInputEvent[] = [];
        for (;;) {
            const marker = this.parts ? END : START;
            const at = input.indexOf(marker);
            if (at >= 0) {
                const text = input.slice(0, at);
                if (this.parts) {
                    this.parts.push(text);
                    events.push({type: "paste", text: this.parts.join("")});
                    this.parts = undefined;
                } else {
                    if (text) events.push({type: "input", text});
                    this.parts = [];
                    events.push({type: "paste_start"});
                }
                input = input.slice(at + marker.length);
                continue;
            }
            let retained = 0;
            for (let size = Math.min(marker.length - 1, input.length); size >= 1; size--) {
                if (input.endsWith(marker.slice(0, size))) {retained = size; break;}
            }
            const text = retained ? input.slice(0, -retained) : input;
            this.pending = retained ? input.slice(-retained) : "";
            if (this.parts) this.parts.push(text);
            else if (text) events.push({type: "input", text});
            return events;
        }
    }
}
