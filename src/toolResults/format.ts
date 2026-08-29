import type {PersistedToolResult, ToolResultChunk} from "./types.js";

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function createPreview(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const candidate = content.slice(0, maxChars);
    const newline = candidate.lastIndexOf("\n");
    const cut = newline > maxChars / 2 ? newline : maxChars;
    return content.slice(0, cut);
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
        `Preview (first ${result.preview.length.toLocaleString()} characters):`,
        escapeProtocolText(result.preview),
        "",
        `Use read_tool_result with result_id=${JSON.stringify(result.resultId)} and offset=0 to read more.`,
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
