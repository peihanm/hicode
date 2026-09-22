import {parse, stringify} from "yaml";
import {z} from "zod";
import {MEMORY_TYPES} from "./types.js";

const headerSchema = z.object({
    name: z.string().trim().min(1).max(120).refine(value => Buffer.byteLength(value) <= 120),
    description: z.string().trim().min(1).max(300).refine(value => Buffer.byteLength(value) <= 300),
    type: z.enum(MEMORY_TYPES),
}).strict();
export function parseMemoryTopic(raw: string, key: string) {
    if (Buffer.byteLength(raw) > 40 * 1024) throw new Error("Memory topic exceeds 40 KiB");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
    if (raw.startsWith("---") && !match) throw new Error("Memory topic has an incomplete YAML header");
    const content = (match ? match[2]! : raw).trim();
    if (!content || Buffer.byteLength(content) > 32 * 1024) throw new Error("Memory topic requires a nonempty body of at most 32 KiB");
    const header = match ? headerSchema.safeParse(parse(match[1]!)) : headerSchema.safeParse({name: key, description: content.split("\n")[0]!.slice(0, 90), type: "project"});
    if (!header.success) throw new Error("Memory header accepts name, description and type (user/feedback/project/reference); no IDs or timestamps");
    if (/[\r\n]/.test(header.data.name + header.data.description)) throw new Error("Memory name and description must be single-line");
    return {...header.data, content};
}
export function serializeMemoryTopic(topic: ReturnType<typeof parseMemoryTopic>): string {
    const {content, ...header} = topic;
    return `---\n${stringify(headerSchema.parse(header))}---\n${content.trim()}\n`;
}
