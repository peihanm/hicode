import {z} from "zod";
import {readFile, stat} from "node:fs/promises";
import type {Tool} from "../types.js";
import {resolveToolPath} from "../shared/paths.js";

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 2000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const inputSchema = z.object({
    path: z.string().describe("文件的绝对或相对路径"),
    offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
            "可选的起始行（1-based）。普通文件不要传；仅在已知目标区间，或文件超过单次读取上限时使用"
        ),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(
            `可选的读取行数。普通文件不要传，默认一次读取完整文件（最多 ${DEFAULT_LIMIT} 行）；仅在已知目标区间，或文件超过单次读取上限时使用，最大 ${MAX_LIMIT} 行`
        ),
});

type Input = z.infer<typeof inputSchema>;

function formatLineNumber(lineNumber: number): string {
    return String(lineNumber).padStart(6, " ");
}

export const readFileTool: Tool<typeof inputSchema> = {
    name: "read_file",
    description: [
        "读取指定路径文件的内容，返回带行号的文本。",
        "",
        "行号格式为 `     1\\t内容`，仅用于定位，不是文件真实内容；调用 edit_file 时不要把行号复制进 old_string。",
        `普通文件不要传 offset/limit，默认一次读取完整文件（最多 ${DEFAULT_LIMIT} 行）；不要人为切成小页连续扫描。`,
        "仅当已经知道所需行段，或文件超过单次读取上限时，才使用 offset/limit 定点或分段读取。",
    ].join("\n"),
    parameters: inputSchema,
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async ({path, offset, limit}: Input, ctx) => {
        const absPath = resolveToolPath(ctx.cwd, path);
        const fileStat = await stat(absPath);
        if (fileStat.size > MAX_FILE_SIZE) {
            return `文件 ${path} 过大（${Math.ceil(fileStat.size / 1024 / 1024)}MB，超过 5MB 限制）。请用 grep 或 bash 针对性查看。`;
        }

        const content = await readFile(absPath, "utf-8");
        if (content.includes("\0")) {
            return `文件 ${path} 看起来是二进制文件，read_file 不返回二进制内容。`;
        }

        const lines = content.split(/\r?\n/);
        const startLine = offset ?? 1;
        const lineLimit = limit ?? DEFAULT_LIMIT;
        if (startLine > lines.length) {
            return `文件 ${path} 共有 ${lines.length} 行，offset=${startLine} 超出范围。`;
        }

        const startIndex = startLine - 1;
        const endIndex = Math.min(startIndex + lineLimit, lines.length);
        const selected = lines.slice(startIndex, endIndex);
        ctx.fileState.recordRead({
            path: absPath,
            content,
            observedContent: selected.join("\n"),
            fullRead: startIndex === 0 && endIndex === lines.length,
        });
        const body = selected
            .map((line, index) => `${formatLineNumber(startLine + index)}\t${line}`)
            .join("\n");

        const header = [
            `文件: ${path}`,
            `行范围: ${startLine}-${endIndex} / ${lines.length}`,
            "注意: 左侧行号不是文件内容，edit_file.old_string 不要包含这些行号。",
        ].join("\n");

        const more =
            endIndex < lines.length
                ? `\n\n...（本次未返回后续 ${lines.length - endIndex} 行）`
                : "";

        return `${header}\n\n${body}${more}`;
    },
};
