import {z} from "zod";

export const fileReadReceiptSchema = z.object({
    path: z.string().min(1).max(4096),
    start: z.number().int().positive(),
    end: z.number().int().positive(),
    total: z.number().int().positive(),
    contentStart: z.number().int().positive().max(8192),
    headerHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.start <= value.end && value.end <= value.total, "Invalid read range");
export type FileReadReceipt = z.infer<typeof fileReadReceiptSchema>;
