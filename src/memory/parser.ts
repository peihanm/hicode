import {Buffer} from "node:buffer";
import type {ZodIssue} from "zod";
import {parse as parseYaml, stringify as stringifyYaml} from "yaml";
import {memoryFrontmatterSchema, memoryUpsertSchema} from "./schema.js";
import {MAX_MEMORY_CONTENT_BYTES, type MemoryEntry, type MemoryUpsertInput,} from "./types.js";

export const MAX_MEMORY_FILE_BYTES = 40 * 1024;

function describeFrontmatterIssue(issue: ZodIssue): string {
    const field = issue.path.join(".") || "frontmatter";
    switch (issue.code) {
        case "invalid_type":
            return `${field}: ${issue.received === "undefined" ? "缺少必填字段" : "类型错误"}；要求 ${issue.expected}`;
        case "invalid_literal":
            return `${field}: 必须为 ${JSON.stringify(issue.expected)}`;
        case "invalid_enum_value":
            return `${field}: 仅允许 ${issue.options.join(" / ")}`;
        case "unrecognized_keys":
            return `未知字段: ${issue.keys.slice(0, 6).map(key => JSON.stringify(key.slice(0, 60))).join("、")}${issue.keys.length > 6 ? `（另有 ${issue.keys.length - 6} 个）` : ""}；请删除这些字段`;
        case "invalid_string":
            if (issue.validation === "datetime") {
                return `${field}: 要求带时区的 ISO 8601 时间，例如 2026-01-01T00:00:00.000Z`;
            }
            return `${field}: ${issue.message}`;
        default:
            return `${field}: ${issue.message}`;
    }
}

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
        const issues = parsed.error.issues;
        throw new Error([
            "Memory 内容无效，frontmatter 无效:",
            ...issues.slice(0, 8).map(issue => `- ${describeFrontmatterIssue(issue).slice(0, 600)}`),
            ...(issues.length > 8 ? [`另有 ${issues.length - 8} 项问题未展开。`] : []),
            "请按 Memory 主题格式修正内容；这不是权限不足，无需申请提权。",
        ].join("\n"));
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
