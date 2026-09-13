import {contentText} from "../images/content.js";
import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
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

export function handoffJsonSchema(): string {
    return JSON.stringify(zodToJsonSchema(schema, {target: "jsonSchema7", $refStrategy: "none"}));
}

export class HandoffFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HandoffFormatError";
    }
}

const sections = [
    ["objective", "Objective and phase"], ["constraints", "User constraints and corrections"],
    ["decisions", "Applicable decisions and stated reasons"], ["files", "Active files and read locations"],
    ["verification", "Executed verification and limits"], ["next", "Next step and stopping point"],
] as const;

/** Labels are added only to the summarizer request, never to the stored original. */
export function labelHandoffSources(messages: readonly Message[], sources: HandoffSources): Message[] {
    if (messages.length !== sources.current.messages.length) throw new Error("handoff source count mismatch");
    return messages.map((message, index) => {
        const cloned = structuredClone(message);
        if (cloned.role === "assistant") delete cloned.reasoning;
        cloned.content = `[source ${sources.current.id}/${index + 1}; role=${message.role}${message.role === "user" ? `; origin=${message.origin}` : ""}]\n${contentText(message.content)}`;
        return cloned;
    });
}

export function renderHandoff(raw: string, sources: HandoffSources): string {
    if (Buffer.byteLength(raw) > 32 * 1024) throw new HandoffFormatError("Task handoff exceeds 32 KiB");
    let parsed: unknown;
    try {parsed = JSON.parse(raw);} catch {throw new HandoffFormatError("Task handoff must be a complete JSON object");}
    const result = schema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues;
        // Only schema paths/codes enter diagnostics; never echo untrusted property names or model text.
        const known = new Set(["objective", "constraints", "decisions", "files", "verification", "next", "version", "text", "sources", "basis"]);
        const details = issues.slice(0, 5).map(issue => {
            const path = issue.path.map(part => typeof part === "number" || known.has(part) ? part : "?").join(".");
            return `${path}: ${issue.code}`;
        }).join("; ");
        throw new HandoffFormatError(`Invalid task handoff format (${issues.length} issues): ${details}. Each item requires text, sources and basis; at most 10 items per category.`);
    }
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
                    throw new Error(`Task handoff reference is outside the current sources: ${ref}`);
                }
            }
            // Model text cannot masquerade as framework framing or a checked citation.
            const text = item.text.replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("[[", "［［");
            return `- [${item.basis === "inferred" ? "inferred, unverified" : "reported source, not a guarantee of current state"}] ${text} ${item.sources.map(ref => `[[${ref}]]`).join(" ")}`;
        }), ""];
    });
    if (!count) throw new Error("Task handoff must not be empty");
    return [`Task handoff v1 · revision ${sources.revision}`, ...body].join("\n").trim();
}
