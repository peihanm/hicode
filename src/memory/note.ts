import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { memoryNoteSchema, type MemoryNote } from "./publicationSchema.js";
export function serializeMemoryNote(note: MemoryNote): string {
    const { content, ...header } = memoryNoteSchema.parse(note);
    return `---\n${stringifyYaml(header)}---\n${content}\n`;
}
export function parseMemoryNote(raw: string): MemoryNote {
    if (Buffer.byteLength(raw) > 9000)
        throw new Error("Memory note exceeds 9000 bytes");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
    if (!match)
        throw new Error("Memory note requires a YAML header with operation: remember or correct, type: user/feedback/project/reference, followed by body content");
    let header: unknown;
    try {
        header = parseYaml(match[1]!);
    }
    catch {
        throw new Error("Invalid Memory note YAML");
    }
    if (!header || typeof header !== "object" || Array.isArray(header))
        throw new Error("Memory note header must be an object");
    if (Object.keys(header).some(key => key !== "operation" && key !== "type"))
        throw new Error("Memory note header supports only operation and type. Put content after the closing ---; no identity, time or index fields are needed.");
    const result = memoryNoteSchema.safeParse({ ...header, content: match[2] });
    if (!result.success) {
        const fields = new Set(result.error.issues.map(issue => issue.path[0]));
        const details = [fields.has("operation") ? "operation: required; only remember / correct are allowed" : undefined,
            fields.has("type") ? "type: required; only user / feedback / project / reference are allowed" : undefined,
            fields.has("content") ? "content: non-empty body required, maximum 8000 bytes" : undefined].filter(Boolean).join("; ");
        throw new Error(`Invalid Memory note format: ${details}. This is a content issue and requires no escalation; identity, time and index fields are not needed.`);
    }
    return result.data;
}
