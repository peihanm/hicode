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

function eraseLines(count: number): string {
    let output = "\u001B[2K";
    for (let index = 1; index < count; index += 1) {
        output += "\u001B[1A\u001B[2K";
    }
    return `${output}\u001B[G`;
}

function physicalLineCount(frame: string, columns: number): number {
    const safeColumns = Math.max(1, Math.floor(columns));
    const lines = frame.split("\n");
    return lines.reduce(
        (count, line) => count + Math.max(1, Math.ceil(stringWidth(line) / safeColumns)),
        0
    );
}

export function createTerminalCursorOutput(
    target: NodeJS.WriteStream
): TerminalCursorOutput {
    let anchored = false;
    let anchorLayout: {
        beforeCursorLine: string;
        afterCursor: string;
    } | undefined;
    let lastFrame = "";
    let lastColumns = target.columns || 80;
    let suppressedErasePrefix = "";
    let inkResizeListener: ((...args: unknown[]) => void) | undefined;

    // Ink 5 的 log-update 只记逻辑行数。终端缩窄并 reflow 后，旧 live frame
    // 可能占据更多物理行；必须在 Ink resize handler 前清掉它，并吞掉下一次
    // 仍按旧逻辑行数生成的 erase prefix，避免重复上移破坏 Static 历史。
    const handleTargetResize = () => {
        const columns = target.columns || 80;
        const shrinking = columns < lastColumns;
        lastColumns = columns;
        if (!shrinking || !lastFrame || suppressedErasePrefix) return;

        const logicalLines = lastFrame.split("\n").length;
        const physicalLines = physicalLineCount(lastFrame, columns);
        if (physicalLines <= logicalLines) return;

        const moveToFrameEnd = anchored && anchorLayout
            ? (() => {
                const afterLines = anchorLayout.afterCursor.split("\n");
                const prefixWidth = stringWidth(anchorLayout.beforeCursorLine);
                const firstLineWidth = prefixWidth + stringWidth(afterLines[0] ?? "");
                const firstRows = Math.floor(Math.max(0, firstLineWidth - 1) / columns) -
                    Math.floor(Math.max(0, prefixWidth - 1) / columns);
                const remainingRows = afterLines.slice(1).reduce(
                    (rows, line) => rows + Math.max(1, Math.ceil(stringWidth(line) / columns)),
                    0
                );
                return `\u001B[${firstRows + remainingRows}B\u001B[1G`;
            })()
            : "";
        suppressedErasePrefix = eraseLines(logicalLines);
        target.write(moveToFrameEnd + eraseLines(physicalLines));
        anchored = false;
        anchorLayout = undefined;
    };
    target.on("resize", handleTargetResize);

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
        if (suppressedErasePrefix) {
            if (data.startsWith(suppressedErasePrefix)) {
                data = data.slice(suppressedErasePrefix.length);
            }
            suppressedErasePrefix = "";
        }
        const formatted = formatTerminalCursorWrite(data, anchored);
        const markerIndex = data.lastIndexOf(TERMINAL_CURSOR_ANCHOR_MARKER);
        anchorLayout = markerIndex < 0
            ? undefined
            : {
                beforeCursorLine: data
                    .slice(0, markerIndex)
                    .split("\n")
                    .at(-1) ?? "",
                afterCursor: data.slice(
                    markerIndex + TERMINAL_CURSOR_ANCHOR_MARKER.length
                ),
            };
        anchored = formatted.anchored;
        lastFrame = data;
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
                    target.off("resize", handleTargetResize);
                    inkResizeListener = undefined;
                    anchored = false;
                    anchorLayout = undefined;
                    lastFrame = "";
                    suppressedErasePrefix = "";
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
