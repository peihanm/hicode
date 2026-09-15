import stringWidth from "string-width";

// Ink treats zero-width text markers as cells and later siblings overwrite them.
// An OSC 8 style survives its cell renderer; both delimiters are removed before terminal output.
export const TERMINAL_CURSOR_ANCHOR_MARKER = "\u001B]8;;pillar-cursor://input\u0007";
export const TERMINAL_CURSOR_ANCHOR_END = "\u001B]8;;\u0007";

export interface TerminalCursorOutput extends NodeJS.WriteStream {
    recordScrollback(mode: "append" | "replay", rendered: string): void;
    disposeCursorOutput(): void;
}

const SAVE_CURSOR = "\u001B7";
const RESTORE_CURSOR = "\u001B8";

export function formatTerminalCursorWrite(
    data: string,
    restorePreviousAnchor: boolean
): { output: string; anchored: boolean } {
    // Cursor visibility/style writes do not move the cursor. Keep the existing anchor.
    if (/^(?:\u001B\[\?25[hl]|\u001B\[[\d;]*m)*$/.test(data)) {
        return {output: data, anchored: restorePreviousAnchor};
    }
    const markerIndex = data.lastIndexOf(TERMINAL_CURSOR_ANCHOR_MARKER);
    const prefix = restorePreviousAnchor ? RESTORE_CURSOR : "";
    if (markerIndex < 0) {
        return {output: prefix + data, anchored: false};
    }

    const beforeMarker = data.slice(0, markerIndex);
    const afterMarker = data.slice(
        markerIndex + TERMINAL_CURSOR_ANCHOR_MARKER.length
    );
    const cleanData = data.split(TERMINAL_CURSOR_ANCHOR_MARKER)
        .map((part, index) => index === 0 ? part : part.replace(TERMINAL_CURSOR_ANCHOR_END, ""))
        .join("");
    const currentLine = beforeMarker.slice(beforeMarker.lastIndexOf("\n") + 1);
    const column = stringWidth(currentLine);
    const rowsFromFrameEnd = (afterMarker.match(/\n/g) ?? []).length;
    const moveUp = rowsFromFrameEnd > 0
        ? `\u001B[${rowsFromFrameEnd}A`
        : "";
    const moveToColumn = `\u001B[${column + 1}G`;

    return {
        output:
            prefix + cleanData + SAVE_CURSOR + moveUp + moveToColumn,
        anchored: true,
    };
}

export function createTerminalCursorOutput(
    target: NodeJS.WriteStream
): TerminalCursorOutput {
    let anchored = false;
    let scrollback = "";
    let recoverAfterOverflow = false;
    let inkResizeListener: ((...args: unknown[]) => void) | undefined;

    const write = (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void
    ): boolean => {
        const encoding = typeof encodingOrCallback === "string"
            ? encodingOrCallback
            : "utf8";
        const data = typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString(encoding);
        // Ink 5 can clear the terminal when a live dialog exceeds its height.
        // Restore the latest committed presentation, never its stale Static cache.
        const inkClear = "\u001B[2J\u001B[3J\u001B[H";
        let frame = data;
        if (data.startsWith(inkClear)) {
            frame = inkClear + scrollback + data.slice(inkClear.length);
            recoverAfterOverflow = true;
        } else if (recoverAfterOverflow && !/^(?:\u001B\[\?25[hl]|\u001B\[[\d;]*m)+$/.test(data)) {
            // Ink's overflow branch bypasses log-update, leaving its previous line
            // count stale. A later erase cannot remove live rows already scrolled
            // offscreen. Rebuild once from retained history before resuming deltas.
            frame = inkClear + scrollback + data.replace(
                /^(?:\u001B\[2K(?:\u001B\[1A\u001B\[2K)*\u001B\[G)/,
                ""
            );
            recoverAfterOverflow = false;
        }
        const formatted = formatTerminalCursorWrite(frame, anchored);
        anchored = formatted.anchored;
        if (typeof encodingOrCallback === "function") {
            return target.write(formatted.output, encodingOrCallback);
        }
        return target.write(formatted.output, encodingOrCallback, callback);
    };

    return new Proxy(target, {
        has(object, property) {
            return property === "recordScrollback" || Reflect.has(object, property);
        },
        get(object, property) {
            if (property === "write") return write;
            if (property === "recordScrollback") {
                return (mode: "append" | "replay", rendered: string) => {
                    scrollback = mode === "replay" ? rendered : scrollback + rendered;
                };
            }
            if (property === "disposeCursorOutput") {
                return () => {
                    scrollback = "";
                    recoverAfterOverflow = false;
                    inkResizeListener = undefined;
                    if (anchored) target.write(RESTORE_CURSOR);
                    anchored = false;
                };
            }
            if (property === "on" || property === "addListener") {
                return (event: string, listener: (...args: unknown[]) => void) => {
                    // createTerminalCursorOutput is used only as Ink stdout. Ink's constructor
                    // subscribes to resize first; retain the callback for off without registering it. Pillar's
                    // TerminalSizeProvider subscribes afterwards and owns ordered, debounced redraws.
                    if (event === "resize" && !inkResizeListener) {
                        inkResizeListener = listener;
                        return object;
                    }
                    object.on(event, listener);
                    return object;
                };
            }
            if (property === "off" || property === "removeListener") {
                return (event: string, listener: (...args: unknown[]) => void) => {
                    if (event === "resize" && listener === inkResizeListener) {
                        inkResizeListener = undefined;
                        return object;
                    }
                    object.off(event, listener);
                    return object;
                };
            }
            const value = Reflect.get(object, property, object);
            return typeof value === "function" ? value.bind(object) : value;
        },
    }) as TerminalCursorOutput;
}
