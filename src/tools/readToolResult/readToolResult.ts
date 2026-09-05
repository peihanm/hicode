import {z} from "zod";
import type {Tool} from "../types.js";
import {DEFAULT_RESULT_READ_BYTES, formatToolResultChunk, MAX_RESULT_READ_BYTES,} from "../../toolResults/index.js";

const inputSchema = z.object({
    result_id: z.string().min(1).describe("工具结果返回的 Result ID"),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("从第几个 UTF-8 byte 开始读取，默认 0"),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULT_READ_BYTES)
        .default(DEFAULT_RESULT_READ_BYTES)
        .describe(`最多读取多少 byte，默认 ${DEFAULT_RESULT_READ_BYTES}，最大 ${MAX_RESULT_READ_BYTES}`),
});

export const readToolResultTool: Tool<typeof inputSchema> = {
    name: "read_tool_result",
    description: [
        "分页读取此前因输出过大而保存的完整工具结果。",
        "只能读取当前 Session 的结果，以及 Fork 父快照明确引用的结果；不接受任意文件路径。",
        "根据返回的 next offset 继续读取后续内容。",
    ].join("\n"),
    parameters: inputSchema,
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute({result_id, offset, limit}, ctx, invocation) {
        try {
            const chunk = await ctx.toolResultReader.readRange({
                resultId: result_id,
                offset,
                limit,
                expectedHash: ctx.fileState.resultDigest(result_id),
            });
            const output = formatToolResultChunk(chunk);
            ctx.fileState.stagePage(invocation.toolCallId, result_id, chunk.offset, chunk.content, output);
            return output;
        } catch (error) {
            return {
                content: `无法读取工具结果 ${result_id}: ${error instanceof Error ? error.message : String(error)}`,
                outcome: "failed",
            };
        }
    },
};
