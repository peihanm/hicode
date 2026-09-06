import type {PersistedToolResult, ToolResultChunk} from "./types.js";

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function createPreview(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    if (maxChars <= 0) return "";
    const marker = maxChars >= 40 ? "\n... [middle omitted] ...\n" : "…";
    const available = maxChars - marker.length;
    let headEnd = Math.ceil(available / 2);
    let tailStart = content.length - Math.floor(available / 2);
    // Keep both cuts outside UTF-16 surrogate pairs without expanding the budget.
    const splitsPair = (index: number) =>
        /[\uD800-\uDBFF]/.test(content.charAt(index - 1)) &&
        /[\uDC00-\uDFFF]/.test(content.charAt(index));
    if (splitsPair(headEnd)) headEnd--;
    if (splitsPair(tailStart)) tailStart++;
    return content.slice(0, headEnd) + marker + content.slice(tailStart);
}

function escapeProtocolText(value: string): string {
    return value
        .replaceAll("<persisted-output", "&lt;persisted-output")
        .replaceAll("</persisted-output>", "&lt;/persisted-output&gt;");
}

export function buildPersistedToolResultMessage(
    result: PersistedToolResult
): string {
    const completeness = result.complete ? "yes" : "no";
    const label = result.complete
        ? "Full output saved"
        : "Only a partial output could be saved";
    return [
        "<persisted-output>",
        `Result ID: ${JSON.stringify(result.resultId)}`,
        `Tool: ${JSON.stringify(result.toolName)}`,
        `Size: ${formatBytes(result.originalByteLength)}`,
        `Complete: ${completeness}`,
        `${label} at: ${JSON.stringify(result.path)}`,
        "",
        "Preview of saved output (bounded; any omitted middle is marked):",
        escapeProtocolText(result.preview),
        "",
        ...(result.complete ? [] : ["This preview ends at the saved portion, not necessarily the end of the original output."]),
        ...(result.byteLength <= 1024 * 1024
            ? ["To locate details, use grep on the saved file path with a keyword pattern, context=3 and head_limit=20. If path access is denied, use read_tool_result below."]
            : ["This saved file exceeds grep's 1 MiB file limit; use read_tool_result below."]),
        `Use read_tool_result with result_id=${JSON.stringify(result.resultId)} and offset=0 to read more.`,
        "Inspect the saved output instead of rerunning the command just to obtain another excerpt.",
        "</persisted-output>",
    ].join("\n");
}

export function buildPersistFailureMessage(
    toolName: string,
    preview: string,
    error: unknown
): string {
    const message = error instanceof Error ? error.message : String(error);
    return [
        `<persisted-output-error tool=${JSON.stringify(toolName)}>`,
        `Output was too large, but the complete result could not be saved: ${message}`,
        "",
        "Bounded preview:",
        escapeProtocolText(preview),
        "</persisted-output-error>",
    ].join("\n");
}

export function formatToolResultChunk(chunk: ToolResultChunk): string {
    const rangeEnd = chunk.nextOffset === chunk.offset
        ? chunk.offset
        : chunk.nextOffset - 1;
    const lines = [
        `Result: ${chunk.resultId}`,
        `Bytes: ${chunk.offset}-${rangeEnd} / ${chunk.byteLength}`,
        `Complete artifact: ${chunk.complete ? "yes" : "no"}`,
        "",
        chunk.content,
    ];
    if (!chunk.eof) {
        lines.push("", `... more available; continue with offset=${chunk.nextOffset}`);
    }
    return lines.join("\n");
}
