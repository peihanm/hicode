import {z} from "zod";
import {MEMORY_TYPES} from "./types.js";
import {memoryKeySchema} from "./schema.js";

const id = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max)
    .refine(value => Buffer.byteLength(value) <= max, `超过 ${max} bytes`);
const singleLine = (max: number) => text(max).refine(value => !/[\r\n]/.test(value), "必须为单行文本");

export const memoryNoteSchema = z.object({
    operation: z.enum(["remember", "correct"]),
    type: z.enum(MEMORY_TYPES),
    content: text(8000),
}).strict();

const originSchema = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("explicit"), sessionId: text(200), turnId: text(200), toolCallId: text(200)}).strict(),
    z.object({kind: z.literal("session"), sessionId: text(200),
        messageHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/), basis: z.enum(["user-stated", "assistant-claimed", "tool-observed"])}).strict(),
]);

export const memorySourceRecordSchema = z.object({
    id, key: memoryKeySchema, type: z.enum(MEMORY_TYPES), content: text(8000),
    origin: originSchema, createdAt: z.string().datetime(), consumed: z.boolean(),
}).strict();

export const memoryDraftTopicSchema = z.object({
    key: memoryKeySchema, name: singleLine(120), description: singleLine(300),
    type: z.enum(MEMORY_TYPES), content: text(32 * 1024),
    sources: z.array(id).min(1).max(32),
}).strict();

const topicSchema = memoryDraftTopicSchema.extend({createdAt: z.string().datetime(), updatedAt: z.string().datetime()}).strict();

export const memoryPublicationSchema = z.object({
    version: z.literal(2), revision: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(),
    summary: z.string().max(4000), topics: z.array(topicSchema).max(200),
    sources: z.array(memorySourceRecordSchema).max(1000),
    revoked: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10_000),
    lease: z.object({id, revision: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(),
        sourceIds: z.array(id).min(1).max(16), expiresAt: z.string().datetime()}).strict().optional(),
    lastIssue: z.string().max(1000).optional(),
}).strict().superRefine((value, ctx) => {
    const keys = new Set(value.topics.map(topic => topic.key));
    const sourceIds = new Set(value.sources.map(source => source.id));
    if (keys.size !== value.topics.length || sourceIds.size !== value.sources.length) {
        ctx.addIssue({code: "custom", message: "Memory 包含重复主题或来源"});
    }
    for (const topic of value.topics) if (topic.sources.some(source => !sourceIds.has(source))) {
        ctx.addIssue({code: "custom", message: "Memory 主题引用不存在的来源", path: ["topics", topic.key]});
    }
    if (value.lease && (value.lease.epoch !== value.epoch || value.lease.sourceIds.some(source => !sourceIds.has(source)))) {
        ctx.addIssue({code: "custom", message: "Memory lease 与当前来源/epoch 不一致"});
    }
});

export type MemoryPublication = z.infer<typeof memoryPublicationSchema>;
export type MemoryNote = z.infer<typeof memoryNoteSchema>;
export type MemorySourceRecord = z.infer<typeof memorySourceRecordSchema>;
export type MemoryDraftTopic = z.infer<typeof memoryDraftTopicSchema>;
export type MemoryLease = NonNullable<MemoryPublication["lease"]>;
