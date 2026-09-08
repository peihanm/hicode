import {persistPreparedImage} from "../images/persist.js";
import {prepareImage} from "../images/prepare.js";
import {IMAGE_MAX_COUNT, IMAGE_REQUEST_BYTES, type ContentPart} from "../images/content.js";
import {throwIfTurnAborted} from "../runtime/abort.js";
import type {ToolResultStore} from "../toolResults/store.js";
import type {BinaryArtifactOrigin, ToolOutput} from "../toolResults/types.js";
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
    input: {
        store: ToolResultStore;
        origin: Extract<BinaryArtifactOrigin, {kind: "tool"}>;
        imageModelSupported: boolean;
        signal: AbortSignal;
    }
): Promise<ToolOutput> {
    throwIfTurnAborted(input.signal);
    if (!result || typeof result !== "object") return normalizeMcpResult(result);
    const record = result as Record<string, unknown>;
    if (!Array.isArray(record.content) || record.isError === true) return normalizeMcpResult(result);
    const imageCount = record.content.filter((raw: unknown) => raw && typeof raw === "object" && "type" in raw && raw.type === "image").length;
    if (imageCount && !input.imageModelSupported) throw new McpToolResultError("当前模型/接口不支持 MCP 图片；图片未送模，不要尝试其他工具绕过");
    if (imageCount > IMAGE_MAX_COUNT || (imageCount && record.content.length > MAX_CONTENT_BLOCKS)) {
        throw new McpToolResultError("MCP 图片结果超过 8 张或 256 个内容块上限");
    }
    const parts: ContentPart[] = [];
    let textChars = 0;
    let rawImageBytes = 0;
    let preparedBytes = 0;
    function appendText(text: string) {
        textChars += text.length;
        if (textChars > MAX_TOTAL_TEXT_CHARS) throw new McpToolResultError("MCP 文本结果超过安全上限");
        const last = parts.at(-1);
        if (last?.type === "text") last.text += "\n" + text;
        else parts.push({type: "text", text});
    }
    for (let index = 0; index < Math.min(record.content.length, MAX_CONTENT_BLOCKS); index++) {
        throwIfTurnAborted(input.signal);
        const raw: unknown = record.content[index];
        if (!raw || typeof raw !== "object") continue;
        const block = raw as Record<string, unknown>;
        if (block.type === "image") {
            // Validate before decoding: Buffer.from(base64) alone silently accepts malformed input.
            const data = decodeImageBlock(block);
            rawImageBytes += data.length;
            if (rawImageBytes > 40 * 1024 * 1024) throw new McpToolResultError("MCP 图片输入合计超过 40 MiB");
            let prepared;
            try {prepared = await prepareImage(data, input.signal);}
            catch {
                throwIfTurnAborted(input.signal);
                throw new McpToolResultError("MCP 图片解码失败：需要静态 PNG/JPEG/WebP，最多 20 MiB/40 MP，归一化后最多 2 MiB");
            }
            preparedBytes += prepared.data.length;
            if (preparedBytes > IMAGE_REQUEST_BYTES) throw new McpToolResultError("MCP 图片归一化后合计超过 10 MiB");
            const reference = await persistPreparedImage({store: input.store, origin: input.origin,
                sourceData: data, prepared, signal: input.signal});
            parts.push(reference);
            continue;
        }
        let data: string | undefined;
        let mimeType = "application/octet-stream";
        let label = String(block.type ?? "binary").slice(0, MAX_METADATA_CHARS);
        if (block.type === "audio" && typeof block.data === "string") {
            data = block.data;
            mimeType = typeof block.mimeType === "string" ? block.mimeType : mimeType;
        } else if (block.type === "resource" && block.resource && typeof block.resource === "object") {
            const resource = block.resource as Record<string, unknown>;
            if (typeof resource.blob === "string") {
                data = resource.blob;
                mimeType = typeof resource.mimeType === "string" ? resource.mimeType : mimeType;
                label = `resource ${String(resource.uri ?? "unknown")}`.slice(0, MAX_METADATA_CHARS);
            }
        }
        if (data === undefined) {
            appendText(normalizeMcpResult({content: [raw]}));
            continue;
        }
        mimeType = mimeType.slice(0, MAX_METADATA_CHARS);
        if (data.length > MAX_BINARY_BASE64_CHARS) {
            appendText(`[${label} omitted because its binary payload exceeds the safe limit]`);
            continue;
        }
        try {
            const artifact = await input.store.persistBinary({origin: input.origin,
                data: Buffer.from(data, "base64"), mimeType,
                artifactId: `${input.store.resultIdFor(input.origin.toolCallId)}-mcp-${index}`});
            appendText(`[${label} saved to ${artifact.path}; ${mimeType}; ${artifact.byteLength} bytes${artifact.complete ? "" : "; truncated"}]`);
        } catch {
            throwIfTurnAborted(input.signal);
            appendText(`[${label} omitted because its binary artifact could not be saved]`);
        }
    }
    if (record.content.length > MAX_CONTENT_BLOCKS) appendText(`[${record.content.length - MAX_CONTENT_BLOCKS} MCP content blocks omitted]`);
    if (record.structuredContent && typeof record.structuredContent === "object") appendText(stableJson(record.structuredContent));
    throwIfTurnAborted(input.signal);
    return imageCount ? {content: parts} : parts.map(part => part.type === "text" ? part.text : "").join("\n") || "(MCP 工具返回空结果)";
}

function decodeImageBlock(block: Record<string, unknown>): Buffer {
    const data = block.data;
    if (typeof data !== "string" || data.length === 0 || data.length > 4 * Math.ceil(20 * 1024 * 1024 / 3) ||
        data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) {
        throw new McpToolResultError("MCP 图片必须是合法 base64，最多 20 MiB；不支持 URL 图片");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== data) throw new McpToolResultError("MCP 图片 base64 无效或超过 20 MiB");
    const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    const actual = png ? "image/png" : jpeg ? "image/jpeg" : webp ? "image/webp" : undefined;
    if (!actual || block.mimeType !== actual) throw new McpToolResultError("MCP 图片 MIME 与实际 PNG/JPEG/WebP 格式不一致");
    return bytes;
}
