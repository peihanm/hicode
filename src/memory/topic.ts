import {parse, stringify} from "yaml";
import {z} from "zod";
import {MEMORY_TYPES} from "./types.js";

export const memoryKeySchema = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters and digits separated by single hyphens only");
const text = (max: number) => z.string().trim().min(1).max(max)
    .refine(value => Buffer.byteLength(value) <= max, `Exceeds ${max} bytes`);
const singleLine = (max: number) => text(max).refine(value => !/[\r\n]/.test(value), "Must be single-line text");
export const memoryTopicSchema = z.object({
    name: singleLine(120),
    description: singleLine(300),
    type: z.enum(MEMORY_TYPES),
    content: text(32 * 1024),
}).strict();

export function parseMemoryTopic(raw: string, key: string) {
    if (Buffer.byteLength(raw) > 40 * 1024) throw new Error("Memory topic exceeds 40 KiB");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
    if (raw.startsWith("---") && !match) throw new Error("Memory topic has an incomplete YAML header");
    const content = (match ? match[2]! : raw).trim();
    if (!memoryTopicSchema.shape.content.safeParse(content).success)
        throw new Error("Memory topic requires a nonempty body of at most 32 KiB");
    let header: unknown = {name: key, description: content.split("\n")[0]!.slice(0, 90), type: "project"};
    if (match) {
        try {header = parse(match[1]!);}
        catch {throw new Error("Invalid Memory YAML header");}
    }
    if (!header || typeof header !== "object" || Array.isArray(header) || "content" in header)
        throw new Error("Memory header must contain only name, description and type");
    const topic = memoryTopicSchema.safeParse({...header, content});
    if (!topic.success)
        throw new Error("Invalid Memory header: name/description must be bounded single-line text, type must be user/feedback/project/reference; no extra fields");
    return topic.data;
}

export function serializeMemoryTopic(topic: ReturnType<typeof parseMemoryTopic>): string {
    const {content, ...header} = memoryTopicSchema.parse(topic);
    return `---\n${stringify(header)}---\n${content}\n`;
}
