import stringWidth from "string-width";

// 只由交互式 CLI 启用。零宽 marker 会在写入真实终端前移除。
export const TERMINAL_CURSOR_ANCHOR_MARKER = "\u200C\u200D\u2060\u200B\u200D\u200C";

const SAVE_CURSOR = "\u001B7";
const RESTORE_CURSOR = "\u001B8";

let cursorAnchorEnabled = false;

export function enableTerminalCursorAnchor(): void {
    cursorAnchorEnabled = true;
}

export function getTerminalCursorAnchorMarker(): string {
    return cursorAnchorEnabled ? TERMINAL_CURSOR_ANCHOR_MARKER : "";
}

export function formatTerminalCursorWrite(
    data: string,
    restorePreviousAnchor: boolean
): { output: string; anchored: boolean } {
    const markerIndex = data.lastIndexOf(TERMINAL_CURSOR_ANCHOR_MARKER);
    const prefix = restorePreviousAnchor ? RESTORE_CURSOR : "";
    if (markerIndex < 0) {
        return {output: prefix + data, anchored: false};
    }

    const beforeMarker = data.slice(0, markerIndex);
    const afterMarker = data.slice(
        markerIndex + TERMINAL_CURSOR_ANCHOR_MARKER.length
    );
    const cleanData = (beforeMarker + afterMarker).split(
        TERMINAL_CURSOR_ANCHOR_MARKER
    ).join("");
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
): NodeJS.WriteStream {
    let anchored = false;
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
        const formatted = formatTerminalCursorWrite(data, anchored);
        anchored = formatted.anchored;
        if (typeof encodingOrCallback === "function") {
            return target.write(formatted.output, encodingOrCallback);
        }
        return target.write(formatted.output, encodingOrCallback, callback);
    };

    return new Proxy(target, {
        get(object, property) {
            if (property === "write") return write;
            const value = Reflect.get(object, property, object);
            return typeof value === "function" ? value.bind(object) : value;
        },
    });
}
