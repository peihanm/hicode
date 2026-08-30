import stringWidth from "string-width";

// 只由交互式 CLI 启用。零宽 marker 会在写入真实终端前移除。
export const TERMINAL_CURSOR_ANCHOR_MARKER = "\u200C\u200D\u2060\u200B\u200D\u200C";

export interface TerminalCursorOutput extends NodeJS.WriteStream {
    disposeCursorOutput(): void;
}

const SAVE_CURSOR = "\u001B7";
const RESTORE_CURSOR = "\u001B8";

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
): TerminalCursorOutput {
    let anchored = false;
    let inkResizeListener: ((...args: unknown[]) => void) | undefined;

    const write = (
        chunk: string | Uint8Array,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void
    ): boolean => {
        const encoding = typeof encodingOrCallback === "string"
            ? encodingOrCallback
            : "utf8";
        let data = typeof chunk === "string"
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
            if (property === "disposeCursorOutput") {
                return () => {
                    inkResizeListener = undefined;
                    anchored = false;
                };
            }
            if (property === "on" || property === "addListener") {
                return (event: string, listener: (...args: unknown[]) => void) => {
                    // createTerminalCursorOutput 只作为 Ink 的 stdout。Ink constructor
                    // 会最先订阅 resize；保留引用供 off 使用，但不注册它。Pillar 的
                    // TerminalSizeProvider 随后订阅并负责一次有序、去抖的重绘。
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
