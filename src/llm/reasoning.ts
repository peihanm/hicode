import {z} from "zod";

const common = {
    id: z.string().nullable().optional(),
    format: z.string().optional(),
    index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
};

// Keep signed and opaque fields intact, and reject unknown shapes rather than
// silently dropping replay state. Stream fragments retain their original order.
export const reasoningDetailSchema = z.discriminatedUnion("type", [
    z.object({...common, type: z.literal("reasoning.text"), text: z.string().nullable().optional(), signature: z.string().nullable().optional()}).strict(),
    z.object({...common, type: z.literal("reasoning.summary"), summary: z.string()}).strict(),
    z.object({...common, type: z.literal("reasoning.encrypted"), data: z.string()}).strict(),
]);
export type ReasoningDetail = z.infer<typeof reasoningDetailSchema>;

export const reasoningStateSchema = z.union([
    z.object({content: z.string().min(1), scope: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
    z.object({
        format: z.literal("openrouter"),
        content: z.string(),
        scope: z.string().regex(/^[a-f0-9]{64}$/),
        details: z.array(reasoningDetailSchema).max(200_000),
    }).strict().refine(value => value.content.trim().length > 0 || value.details.length > 0),
]).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024);

export type ReasoningState = z.infer<typeof reasoningStateSchema>;
