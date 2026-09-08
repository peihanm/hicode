import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { memoryNoteSchema, type MemoryNote } from "./publicationSchema.js";
export function serializeMemoryNote(note: MemoryNote): string {
    const { content, ...header } = memoryNoteSchema.parse(note);
    return `---\n${stringifyYaml(header)}---\n${content}\n`;
}
export function parseMemoryNote(raw: string): MemoryNote {
    if (Buffer.byteLength(raw) > 9000)
        throw new Error("Memory note 超过 9000 bytes");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
    if (!match)
        throw new Error("Memory note 需要 YAML 头 operation: remember 或 correct、type: user/feedback/project/reference，以及头部之后的正文");
    let header: unknown;
    try {
        header = parseYaml(match[1]!);
    }
    catch {
        throw new Error("Memory note YAML 无效");
    }
    if (!header || typeof header !== "object" || Array.isArray(header))
        throw new Error("Memory note 头必须是对象");
    if (Object.keys(header).some(key => key !== "operation" && key !== "type"))
        throw new Error("Memory note 头仅支持 operation 和 type；正文放在结束的 --- 之后，无需身份、时间或索引字段。");
    const result = memoryNoteSchema.safeParse({ ...header, content: match[2] });
    if (!result.success) {
        const fields = new Set(result.error.issues.map(issue => issue.path[0]));
        const details = [fields.has("operation") ? "operation: 必填，只允许 remember / correct" : undefined,
            fields.has("type") ? "type: 必填，只允许 user / feedback / project / reference" : undefined,
            fields.has("content") ? "content: 需要非空正文，最多 8000 bytes" : undefined].filter(Boolean).join("; ");
        throw new Error(`Memory note 格式无效: ${details}。这是内容问题，无需提权；不需要身份、时间或索引字段。`);
    }
    return result.data;
}
