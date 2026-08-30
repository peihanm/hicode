import {stableJson} from "./json.js";

const MAX_CONTENT_BLOCKS = 256;
const MAX_TEXT_BLOCK_CHARS = 16 * 1024 * 1024;
const MAX_TOTAL_TEXT_CHARS = 64 * 1024 * 1024;
const MAX_BINARY_BASE64_CHARS = 90 * 1024 * 1024;
const MAX_METADATA_CHARS = 4096;

class McpToolResultError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "McpToolResultError";
    }
}

function normalizeMcpResult(result: unknown): string {
    if (!result || typeof result !== "object") return String(result ?? "");
    const record = result as Record<string, unknown>;
    if ("toolResult" in record) return stableJson(record.toolResult);
    const blocks: string[] = [];
    let totalTextChars = 0;
    if (Array.isArray(record.content)) {
        for (const raw of record.content.slice(0, MAX_CONTENT_BLOCKS)) {
            if (!raw || typeof raw !== "object") continue;
            const block = raw as Record<string, unknown>;
            if (block.type === "text" && typeof block.text === "string") {
                const text = block.text.slice(0, MAX_TEXT_BLOCK_CHARS);
                totalTextChars += text.length;
                if (totalTextChars > MAX_TOTAL_TEXT_CHARS) {
                    throw new McpToolResultError("MCP 文本结果超过安全上限");
                }
                blocks.push(
                    block.text.length > MAX_TEXT_BLOCK_CHARS
                        ? `${text}\n[MCP text block truncated at safe limit]`
                        : text
                );
            } else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
                const resource = block.resource as Record<string, unknown>;
                const uri = typeof resource.uri === "string"
                    ? resource.uri.slice(0, MAX_METADATA_CHARS)
                    : "unknown";
                if (typeof resource.text === "string") {
                    const text = resource.text.slice(0, MAX_TEXT_BLOCK_CHARS);
                    totalTextChars += text.length;
                    if (totalTextChars > MAX_TOTAL_TEXT_CHARS) {
                        throw new McpToolResultError("MCP 文本结果超过安全上限");
                    }
                    blocks.push(
                        `[Resource ${uri}]\n${text}` +
                        (resource.text.length > MAX_TEXT_BLOCK_CHARS
                            ? "\n[MCP resource text truncated at safe limit]"
                            : "")
                    );
                }
                else if (typeof resource.blob === "string") {
                    const bytes = Math.floor(resource.blob.length * 3 / 4);
                    blocks.push(`[Binary resource omitted: ${uri}, ${String(resource.mimeType ?? "application/octet-stream")}, ${bytes} bytes]`);
                }
            } else if (block.type === "resource_link") {
                blocks.push(`[Resource link: ${String(block.name ?? "resource")} ${String(block.uri ?? "")}]`);
            } else if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
                const bytes = Math.floor(block.data.length * 3 / 4);
                blocks.push(`[${block.type} content omitted: ${String(block.mimeType ?? "application/octet-stream")}, ${bytes} bytes]`);
            } else {
                blocks.push(`[Unsupported MCP content: ${String(block.type ?? "unknown")}]`);
            }
        }
        if (record.content.length > MAX_CONTENT_BLOCKS) {
            blocks.push(
                `[${record.content.length - MAX_CONTENT_BLOCKS} MCP content blocks omitted]`
            );
        }
    }
    if (record.structuredContent && typeof record.structuredContent === "object") {
        blocks.push(stableJson(record.structuredContent));
    }
    const content = blocks.join("\n");
    if (record.isError === true) throw new McpToolResultError(content || "MCP 工具返回错误");
    return content || "(MCP 工具返回空结果)";
}

export async function normalizeMcpResultWithArtifacts(
    result: unknown,
    persistBinary: (input: {
        data: Buffer;
        mimeType: string;
        index: number;
        label: string;
    }) => Promise<{ path: string; byteLength: number; complete: boolean }>
): Promise<string> {
    if (!result || typeof result !== "object") return normalizeMcpResult(result);
    const record = result as Record<string, unknown>;
    if (!Array.isArray(record.content)) return normalizeMcpResult(result);
    const content: unknown[] = [];
    for (
        let index = 0;
        index < Math.min(record.content.length, MAX_CONTENT_BLOCKS);
        index++
    ) {
        const raw = record.content[index];
        if (!raw || typeof raw !== "object") {
            content.push(raw);
            continue;
        }
        const block = raw as Record<string, unknown>;
        let data: string | undefined;
        let mimeType = "application/octet-stream";
        let label = String(block.type ?? "binary");
        if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
            data = block.data;
            mimeType = typeof block.mimeType === "string" ? block.mimeType : mimeType;
        } else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
            const resource = block.resource as Record<string, unknown>;
            if (typeof resource.blob === "string") {
                data = resource.blob;
                mimeType = typeof resource.mimeType === "string" ? resource.mimeType : mimeType;
                label = `resource ${String(resource.uri ?? "unknown")}`;
            }
        }
        if (!data) {
            content.push(raw);
            continue;
        }
        if (data.length > MAX_BINARY_BASE64_CHARS) {
            content.push({
                type: "text",
                text: `[${label.slice(0, MAX_METADATA_CHARS)} omitted because its binary payload exceeds the safe limit]`,
            });
            continue;
        }
        try {
            const artifact = await persistBinary({
                data: Buffer.from(data, "base64"),
                mimeType: mimeType.slice(0, MAX_METADATA_CHARS),
                index,
                label: label.slice(0, MAX_METADATA_CHARS),
            });
            content.push({
                type: "text",
                text: `[${label} saved to ${artifact.path}; ${mimeType}; ${artifact.byteLength} bytes${artifact.complete ? "" : "; truncated"}]`,
            });
        } catch (error) {
            content.push({
                type: "text",
                text: `[${label} omitted because its binary artifact could not be saved: ${error instanceof Error ? error.message : String(error)}]`,
            });
        }
    }
    if (record.content.length > MAX_CONTENT_BLOCKS) {
        content.push({
            type: "text",
            text: `[${record.content.length - MAX_CONTENT_BLOCKS} MCP content blocks omitted]`,
        });
    }
    return normalizeMcpResult({...record, content});
}
