import {z} from "zod";
import type {Message} from "../llm/types.js";
import type {SessionArchiveRecord} from "../session/archiveSchema.js";

export interface HandoffSources {
    current: SessionArchiveRecord;
    previous: readonly SessionArchiveRecord[];
    revision: number;
}

const itemSchema = z.object({
    text: z.string().trim().min(1).max(2000),
    sources: z.array(z.string().regex(/^[a-f0-9]{64}\/[1-9][0-9]*$/)).max(8),
    basis: z.enum(["reported", "inferred"]),
}).strict().refine(item => item.basis === "inferred" || item.sources.length > 0,
    "reported item requires a source");
const items = z.array(itemSchema).max(10);
const schema = z.object({version: z.literal(1), objective: items, constraints: items,
    decisions: items, files: items, verification: items, next: items}).strict();

const sections = [
    ["objective", "目标与当前阶段"], ["constraints", "用户约束与纠正"],
    ["decisions", "仍适用的决定与理由"], ["files", "当前文件与读取定位"],
    ["verification", "已执行验证及局限"], ["next", "下一步与暂停位置"],
] as const;

/** Labels are added only to the summarizer request, never to the stored original. */
export function labelHandoffSources(messages: readonly Message[], sources: HandoffSources): Message[] {
    if (messages.length !== sources.current.messages.length) throw new Error("handoff source count mismatch");
    return messages.map((message, index) => {
        const cloned = structuredClone(message);
        if (cloned.role === "assistant") delete cloned.reasoning_content;
        cloned.content = `[source ${sources.current.id}/${index + 1}; role=${message.role}]\n${message.content ?? ""}`;
        return cloned;
    });
}

export function renderHandoff(raw: string, sources: HandoffSources): string {
    if (Buffer.byteLength(raw) > 32 * 1024) throw new Error("工作交接超过 32 KiB 上限");
    let parsed: unknown;
    try {parsed = JSON.parse(raw);} catch {throw new Error("工作交接必须是完整 JSON 对象");}
    const result = schema.safeParse(parsed);
    if (!result.success) throw new Error(`工作交接格式无效: ${result.error.issues.map(issue => issue.path.join(".") + ": " + issue.message).join("; ")}`);
    const records = new Map([...sources.previous, sources.current].map(record => [record.id, record]));
    let count = 0;
    const body = sections.flatMap(([key, title]) => {
        const entries = result.data[key];
        if (!entries.length) return [];
        count += entries.length;
        return [title, ...entries.map(item => {
            for (const ref of item.sources) {
                const [id, ordinal] = ref.split("/");
                const record = records.get(id!);
                if (!record || !Number.isSafeInteger(Number(ordinal)) || Number(ordinal) > record.messages.length) {
                    throw new Error(`工作交接引用不属于当前来源: ${ref}`);
                }
            }
            // Model text cannot masquerade as framework framing or a checked citation.
            const text = item.text.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("[[", "［［");
            return `- [${item.basis === "inferred" ? "推断，未核实" : "来源转述，非当前状态保证"}] ${text} ${item.sources.map(ref => `[[${ref}]]`).join(" ")}`;
        }), ""];
    });
    if (!count) throw new Error("工作交接不能为空");
    return [`工作交接 v1 · 修订 ${sources.revision}`, ...body].join("\n").trim();
}
