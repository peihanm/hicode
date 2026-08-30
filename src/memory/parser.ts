import {Buffer} from "node:buffer";
import {parse as parseYaml, stringify as stringifyYaml} from "yaml";
import {memoryFrontmatterSchema, memoryUpsertSchema} from "./schema.js";
import {MAX_MEMORY_CONTENT_BYTES, type MemoryEntry, type MemoryUpsertInput,} from "./types.js";

export const MAX_MEMORY_FILE_BYTES = 40 * 1024;

function ensureContentSize(content: string): void {
    if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_CONTENT_BYTES) {
        throw new Error(`Memory 正文超过 ${MAX_MEMORY_CONTENT_BYTES} bytes`);
    }
}

export function parseMemoryFile(
    path: string,
    raw: string
): MemoryEntry {
    if (Buffer.byteLength(raw, "utf8") > MAX_MEMORY_FILE_BYTES) {
        throw new Error(`Memory 文件超过 ${MAX_MEMORY_FILE_BYTES} bytes`);
    }
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) throw new Error("缺少合法 YAML frontmatter");

    let frontmatter: unknown;
    try {
        frontmatter = parseYaml(match[1] ?? "");
    } catch (error) {
        throw new Error(
            `YAML 无法解析: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    const parsed = memoryFrontmatterSchema.safeParse(frontmatter);
    if (!parsed.success) {
        throw new Error(`frontmatter 无效: ${parsed.error.issues[0]?.message ?? "未知错误"}`);
    }
    const content = (match[2] ?? "").trim();
    if (!content) throw new Error("Memory 正文不能为空");
    ensureContentSize(content);

    return {
        version: 1,
        key: parsed.data.key,
        name: parsed.data.name,
        description: parsed.data.description,
        type: parsed.data.type,
        source: parsed.data.source,
        createdAt: parsed.data.created_at,
        updatedAt: parsed.data.updated_at,
        content,
        path,
    };
}

export function serializeMemoryFile(
    input: MemoryUpsertInput,
    timestamps: {createdAt: string; updatedAt: string}
): string {
    const parsed = memoryUpsertSchema.parse(input);
    ensureContentSize(parsed.content);
    const frontmatter = stringifyYaml({
        version: 1,
        key: parsed.key,
        name: parsed.name,
        description: parsed.description,
        type: parsed.type,
        source: parsed.source,
        created_at: timestamps.createdAt,
        updated_at: timestamps.updatedAt,
    }).trimEnd();
    return `---\n${frontmatter}\n---\n\n${parsed.content.trim()}\n`;
}
