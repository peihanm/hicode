import {createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode} from "react";
import {useInput, useStdin, useStdout, type Key} from "ink";
import {BracketedPasteDecoder} from "./bracketedPaste.js";
import {stripVTControlCharacters} from "node:util";

type PasteTarget = {receive(text: string): void};

class TerminalInput {
    private readonly decoder = new BracketedPasteDecoder();
    private readonly targets = new Set<PasteTarget>();
    private pasteTarget: PasteTarget | undefined;
    private forwarding = false;
    private keyTimer: ReturnType<typeof setTimeout> | undefined;
    suppressed = false;

    dispose(): void {clearTimeout(this.keyTimer);}

    register(target: PasteTarget): () => void {
        this.targets.add(target);
        return () => {this.targets.delete(target);};
    }

    receive(chunk: string, forward: (text: string) => void): void {
        if (this.forwarding) return;
        clearTimeout(this.keyTimer);
        const events = this.decoder.push(chunk);
        if (events.length === 1 && events[0]?.type === "input" && events[0].text === chunk) {
            this.suppressed = false;
            return;
        }
        this.suppressed = true;
        for (const event of events) {
            if (event.type === "paste_start") {
                this.pasteTarget = [...this.targets].at(-1);
            } else if (event.type === "paste") {
                const target = this.pasteTarget;
                this.pasteTarget = undefined;
                if (target && this.targets.has(target)) {
                    target.receive(stripVTControlCharacters(event.text)
                        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""));
                }
            } else {
                this.forwarding = true;
                this.suppressed = false;
                try {forward(event.text);}
                finally {this.forwarding = false; this.suppressed = true;}
            }
        }
        if (this.decoder.hasPendingKey) {
            // A lone Escape is ambiguous with a split start marker. Longer
            // marker prefixes and paste bodies wait for input without a timer.
            this.keyTimer = setTimeout(() => {
                const text = this.decoder.flushKey();
                this.forwarding = true;
                this.suppressed = false;
                try {if (text) forward(text);}
                finally {this.forwarding = false;}
            }, 10);
        }
    }
}

const TerminalInputContext = createContext<TerminalInput | undefined>(undefined);

/** One owner per interactive Ink tree; no global stdin patch or timer-based paste boundary. */
export function TerminalInputProvider({children}: {children: ReactNode}) {
    const {stdin, internal_eventEmitter: emitter} = useStdin();
    const {stdout} = useStdout();
    const [input] = useState(() => new TerminalInput());
    useLayoutEffect(() => {
        // Ink emits its raw string before useInput parses escape/key sequences.
        const receive = (chunk: string) => input.receive(chunk, text => emitter.emit("input", text));
        emitter.prependListener("input", receive);
        const terminal = stdin.isTTY && stdout.isTTY;
        if (terminal) stdout.write("\u001b[?2004h");
        return () => {
            input.dispose();
            emitter.removeListener("input", receive);
            if (terminal) stdout.write("\u001b[?2004l");
        };
    }, [stdin, stdout, emitter, input]);
    return <TerminalInputContext.Provider value={input}>{children}</TerminalInputContext.Provider>;
}

/** Preserve Ink key semantics for ordinary input; pasted text never invokes shortcut handlers. */
export function useTerminalInput(handler: (input: string, key: Key) => void,
    options: {isActive?: boolean; onPaste?: (text: string) => void} = {}) {
    const input = useContext(TerminalInputContext);
    const onPaste = useRef(options.onPaste);
    onPaste.current = options.onPaste;
    const acceptsPaste = !!options.onPaste;
    useEffect(() => {
        if (!input || options.isActive === false || !acceptsPaste) return;
        return input.register({receive: text => onPaste.current?.(text)});
    }, [input, options.isActive, acceptsPaste]);
    useInput((text, key) => {if (!input?.suppressed) handler(text, key);}, {isActive: options.isActive});
}
