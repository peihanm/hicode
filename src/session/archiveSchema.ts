import {z} from "zod";

export const archiveRecordSchema = z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    messages: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000),
}).strict();

export type SessionArchiveRecord = z.infer<typeof archiveRecordSchema>;
