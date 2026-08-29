import {z} from "zod";
import {Buffer} from "node:buffer";
import {MAX_MEMORY_CONTENT_BYTES, MEMORY_TYPES} from "./types.js";

const singleLine = (max: number) =>
    z.string().trim().min(1).max(max).refine(
        (value) => !/[\r\n]/.test(value),
        "必须是单行文本"
    );

const memoryContentSchema = z
    .string()
    .trim()
    .min(1)
    .max(MAX_MEMORY_CONTENT_BYTES)
    .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_MEMORY_CONTENT_BYTES,
        `Memory 正文超过 ${MAX_MEMORY_CONTENT_BYTES} bytes`
    );

export const memoryKeySchema = z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "只能包含小写字母、数字和单个连字符分隔");

export const memoryTypeSchema = z.enum(MEMORY_TYPES);
const memorySourceSchema = z.enum(["explicit", "automatic"]);

export const memoryFrontmatterSchema = z.object({
    version: z.literal(1),
    key: memoryKeySchema,
    name: singleLine(120),
    description: singleLine(300),
    type: memoryTypeSchema,
    source: memorySourceSchema,
    created_at: z.string().datetime({offset: true}),
    updated_at: z.string().datetime({offset: true}),
}).strict();

export const memoryUpsertSchema = z.object({
    key: memoryKeySchema,
    name: singleLine(120),
    description: singleLine(300),
    type: memoryTypeSchema,
    content: memoryContentSchema,
    source: memorySourceSchema,
}).strict();
