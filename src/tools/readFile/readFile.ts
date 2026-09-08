import {z} from "zod";
import {isUtf8} from "node:buffer";
import {createHash} from "node:crypto";
import {readFileSnapshot} from "../shared/fileSnapshot.js";
import type {Tool} from "../types.js";
import {normalizeFileText} from "../shared/fileState.js";
import {resolveToolPath} from "../shared/paths.js";
import {readSavedOutput} from "./savedOutput.js";
import {resolveSessionArchiveFile} from "../../session/archiveAccess.js";
import {isMemoryStoragePath} from "../../memory/publicationAccess.js";

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
        "也可读取工具返回的已保存结果路径，offset/limit 同样使用行号；结果文件按预算展示，超长单行会标记省略。日志不作为源码当前版本的读取记录。",
        "二进制资产和超过 5 MiB 的文本仅返回目标摘要，可用于确认删除，不能授权正文编辑；超过 20 MiB 拒绝读取。",
        "需要理解图片内容时使用 view_image；本工具的二进制摘要不会将图片像素提供给模型。",
        "",
        "行号格式为 `     1\\t内容`，仅用于定位，不是文件真实内容；调用 edit_file 时不要把行号复制进 old_string。",
        `普通文件不要传 offset/limit，默认一次读取完整文件（最多 ${DEFAULT_LIMIT} 行）；不要人为切成小页连续扫描。`,
        "仅当已经知道所需行段，或文件超过单次读取上限时，才使用 offset/limit 定点或分段读取。",
    ].join("\n"),
    parameters: inputSchema,
    maxResultSizeChars: Infinity,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async ({path, offset, limit}: Input, ctx, invocation) => {
        const absPath = resolveToolPath(ctx.cwd, path);
        if (isMemoryStoragePath(ctx.storage, absPath)) {
            if (!ctx.memoryFiles) throw new Error("当前 Agent 没有 Memory 文件能力");
            await ctx.memoryFiles.prepare(absPath, "read_file");
        }
        const archive = await resolveSessionArchiveFile(ctx.storage, ctx.sessionArchives, absPath);
        if (archive) return readSavedOutput(archive, offset ?? 1, limit ?? DEFAULT_LIMIT, ctx.signal, "archive");
        const saved = await ctx.toolResultFiles.resolveFile(absPath);
        if (saved) return readSavedOutput(saved, offset ?? 1, limit ?? DEFAULT_LIMIT, ctx.signal);
        const snapshot = await readFileSnapshot(absPath);
        const binary = !isUtf8(snapshot.content) || snapshot.content.includes(0);
        if (snapshot.content.length > MAX_FILE_SIZE || binary) {
            const output = [
                `文件: ${path}`,
                `类型: ${binary ? "二进制" : "大型文本"}`,
                `大小: ${snapshot.content.length} bytes`,
                `SHA256: ${createHash("sha256").update(snapshot.content).digest("hex")}`,
                "已确认目标版本；未展示正文，不能据此 edit_file/write_file。可按权限策略使用 delete_file 删除此版本。",
            ].join("\n");
            ctx.fileState.stageRead({toolCallId: invocation.toolCallId, path: absPath, content: snapshot.content,
                normalizedBytes: snapshot.content.length, output, segments: [], identity: snapshot.identity});
            return output;
        }
        const content = snapshot.content.toString("utf8");
        const normalized = normalizeFileText(content);
        const lines = normalized.split("\n");
        const startLine = offset ?? 1;
        const lineLimit = limit ?? DEFAULT_LIMIT;
        if (startLine > lines.length) {
            return `文件 ${path} 共有 ${lines.length} 行，offset=${startLine} 超出范围。`;
        }

        const startIndex = startLine - 1;
        const endIndex = Math.min(startIndex + lineLimit, lines.length);
        const selected = lines.slice(startIndex, endIndex);
        const body = selected
            .map((line, index) => `${formatLineNumber(startLine + index)}\t${line}`)
            .join("\n");

        const header = [
            `文件: ${path}`,
            `行范围: ${startLine}-${endIndex} / ${lines.length}`,
            "注意: 左侧行号不是文件内容，edit_file.edits[].old_string 不要包含这些行号。",
        ].join("\n");

        const more =
            endIndex < lines.length
                ? `\n\n...（本次未返回后续 ${lines.length - endIndex} 行）`
                : "";

        const output = `${header}\n\n${body}${more}`;
        let outputByte = Buffer.byteLength(`${header}\n\n`);
        let fileByte = Buffer.byteLength(lines.slice(0, startIndex).join("\n")) + (startIndex > 0 ? 1 : 0);
        const segments = selected.map((line, index): readonly [number, number, number] => {
            const prefix = Buffer.byteLength(`${formatLineNumber(startLine + index)}\t`);
            const bytes = Buffer.byteLength(line) + (startIndex + index < lines.length - 1 ? 1 : 0);
            const segment = [outputByte + prefix, outputByte + prefix + bytes, fileByte] as const;
            outputByte += prefix + Buffer.byteLength(line) + 1;
            fileByte += bytes;
            return segment;
        });
        ctx.fileState.stageRead({toolCallId: invocation.toolCallId, path: absPath, content,
            normalizedBytes: Buffer.byteLength(normalized), output, segments, identity: snapshot.identity});
        return output;
    },
};
