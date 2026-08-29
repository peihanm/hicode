import {stableJson} from "./json.js";

class McpToolResultError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "McpToolResultError";
    }
}

export function normalizeMcpResult(result: unknown): string {
    if (!result || typeof result !== "object") return String(result ?? "");
    const record = result as Record<string, unknown>;
    if ("toolResult" in record) return stableJson(record.toolResult);
    const blocks: string[] = [];
    if (Array.isArray(record.content)) {
        for (const raw of record.content) {
            if (!raw || typeof raw !== "object") continue;
            const block = raw as Record<string, unknown>;
            if (block.type === "text" && typeof block.text === "string") {
                blocks.push(block.text);
            } else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
                const resource = block.resource as Record<string, unknown>;
                const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
                if (typeof resource.text === "string") blocks.push(`[Resource ${uri}]\n${resource.text}`);
                else if (typeof resource.blob === "string") {
                    const bytes = Buffer.from(resource.blob, "base64").byteLength;
                    blocks.push(`[Binary resource omitted: ${uri}, ${String(resource.mimeType ?? "application/octet-stream")}, ${bytes} bytes]`);
                }
            } else if (block.type === "resource_link") {
                blocks.push(`[Resource link: ${String(block.name ?? "resource")} ${String(block.uri ?? "")}]`);
            } else if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
                const bytes = Buffer.from(block.data, "base64").byteLength;
                blocks.push(`[${block.type} content omitted: ${String(block.mimeType ?? "application/octet-stream")}, ${bytes} bytes]`);
            } else {
                blocks.push(`[Unsupported MCP content: ${String(block.type ?? "unknown")}]`);
            }
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
    for (let index = 0; index < record.content.length; index++) {
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
        try {
            const artifact = await persistBinary({
                data: Buffer.from(data, "base64"),
                mimeType,
                index,
                label,
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
    return normalizeMcpResult({...record, content});
}
