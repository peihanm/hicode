import {z} from "zod";
import {appendFile, readFile, stat} from "node:fs/promises";
import type {Tool} from "../types.js";
import {walk} from "./utils.js";
import {extname} from "node:path";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";
import {throwIfTurnAborted} from "../../runtime/abort.js";

const INLINE_RESULT_CHARS = 20_000;
const MAX_FILE_SIZE = 1024 * 1024; // 跳过 1MB 以上的文件
const MAX_CONTEXT = 10;
const MAX_HEAD_LIMIT = 10_000;

const FILE_TYPE_EXTENSIONS: Record<string, readonly string[]> = {
    js: [".js", ".jsx", ".mjs", ".cjs"],
    ts: [".ts", ".tsx", ".mts", ".cts"],
    py: [".py", ".pyi"],
    rust: [".rs"],
    go: [".go"],
    java: [".java"],
    c: [".c", ".h"],
    cpp: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
    css: [".css", ".scss", ".sass", ".less"],
    html: [".html", ".htm"],
    json: [".json", ".jsonc"],
    markdown: [".md", ".mdx"],
    yaml: [".yaml", ".yml"],
    shell: [".sh", ".bash", ".zsh", ".fish"],
    sql: [".sql"],
};

const inputSchema = z.object({
    pattern: z.string().describe("正则表达式"),
    path: z.string().default(".").describe("搜索起始目录或文件"),
    glob: z
        .string()
        .optional()
        .describe("文件名过滤 glob，如 *.ts。不传则搜索所有文件"),
    type: z
        .string()
        .optional()
        .describe("按常见文件类型过滤，如 ts、js、py、rust、go、html、css"),
    output_mode: z
        .enum(["content", "files_with_matches", "count"])
        .default("content")
        .describe("输出匹配内容、匹配文件路径，或每个文件的匹配数"),
    context: z
        .number()
        .int()
        .min(0)
        .max(MAX_CONTEXT)
        .default(0)
        .describe("匹配行前后各显示多少行上下文。默认 0，最大 10"),
    before: z
        .number()
        .int()
        .min(0)
        .max(MAX_CONTEXT)
        .optional()
        .describe("匹配行前显示多少行；传入后覆盖 context 的前置行数"),
    after: z
        .number()
        .int()
        .min(0)
        .max(MAX_CONTEXT)
        .optional()
        .describe("匹配行后显示多少行；传入后覆盖 context 的后置行数"),
    ignore_case: z.boolean().default(false).describe("是否忽略大小写"),
    multiline: z
        .boolean()
        .default(false)
        .describe("是否允许正则跨行匹配；开启后 . 可匹配换行"),
    head_limit: z
        .number()
        .int()
        .min(0)
        .max(MAX_HEAD_LIMIT)
        .optional()
        .describe("最多显示多少条结果；0 或不传表示不限制，大范围搜索建议设置"),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("跳过前 N 条结果，与 head_limit 组合分页"),
    include_hidden: z
        .boolean()
        .default(false)
        .describe("是否搜索隐藏文件和隐藏目录（如 .github/.pillar）。默认 false；.git 始终跳过"),
});

type Input = z.infer<typeof inputSchema>;

function formatLineNumber(lineNumber: number): string {
    return String(lineNumber).padStart(6, " ");
}

function formatContextBlock(
    relPath: string,
    lines: string[],
    matchIndex: number,
    before: number,
    after: number
): string {
    const start = Math.max(0, matchIndex - before);
    const end = Math.min(lines.length - 1, matchIndex + after);
    const out = [`${relPath}:${matchIndex + 1}`];
    for (let i = start; i <= end; i++) {
        const marker = i === matchIndex ? ">" : " ";
        out.push(`${marker}${formatLineNumber(i + 1)}\t${lines[i]}`);
    }
    return out.join("\n");
}

function matchesFileType(file: string, type: string | undefined): boolean {
    if (!type) return true;
    const normalized = type.toLowerCase().replace(/^\./, "");
    const extensions = FILE_TYPE_EXTENSIONS[normalized];
    const extension = extname(file).toLowerCase();
    return extensions
        ? extensions.includes(extension)
        : extension === `.${normalized}`;
}

function lineIndexAt(lineStarts: readonly number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid]! <= offset) low = mid + 1;
        else high = mid - 1;
    }
    return Math.max(0, high);
}

function buildLineStarts(content: string): number[] {
    const starts = [0];
    for (let index = 0; index < content.length; index++) {
        if (content.charCodeAt(index) === 10) starts.push(index + 1);
    }
    return starts;
}

export const grepTool: Tool<typeof inputSchema> = {
    name: "grep",
    description: [
        "强大的文件内容正则搜索工具。当任务是寻找代码位置、字面量、配置值或大文件中的目标时，先用 grep 缩小范围，不要盲目分段读取。",
        "默认 content 模式返回文件、行号和匹配行；支持 files_with_matches/count、glob/type、上下文、分页和 multiline。",
        "已经明确具体小文件且需要整体理解时，可以直接 read_file；找符号定义/引用/类型优先使用 lsp。",
    ].join("\n"),
    parameters: inputSchema,
    maxResultSizeChars: 20_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (
        {
            pattern,
            path,
            glob,
            type,
            output_mode,
            context,
            before,
            after,
            ignore_case,
            multiline,
            head_limit,
            offset,
            include_hidden,
        }: Input,
        ctx,
        invocation
    ) => {
        let regex: RegExp;
        try {
            regex = new RegExp(
                pattern,
                `${ignore_case ? "i" : ""}${multiline ? "gms" : ""}`
            );
        } catch (err) {
            return `正则表达式不合法: ${err instanceof Error ? err.message : err}`;
        }

        const files: string[] = [];
        const searchRoot = resolveToolPath(ctx.cwd, path);
        let inlineOutput = "";
        let capturePath: string | undefined;
        let totalBytes = 0;
        let captureBytes = 0;
        let totalMatches = 0;
        let matchedFiles = 0;
        let resultEntries = 0;
        let displayedEntries = 0;
        let skippedCount = 0;
        let complete = true;

        const appendResult = async (result: string): Promise<boolean> => {
            const text = displayedEntries === 0 ? result : `\n${result}`;
            displayedEntries++;
            const bytes = Buffer.byteLength(text);
            totalBytes += bytes;
            if (!capturePath && inlineOutput.length + text.length <= INLINE_RESULT_CHARS) {
                inlineOutput += text;
                return true;
            }
            if (!capturePath) {
                capturePath = await ctx.toolResultStore.createCapture();
                const initial = Buffer.from(inlineOutput, "utf8");
                const initialWritable = initial.subarray(
                    0,
                    ctx.toolResultStore.maxArtifactBytes
                );
                await appendFile(capturePath, initialWritable);
                captureBytes = initialWritable.length;
                inlineOutput = "";
                if (initialWritable.length < initial.length) {
                    complete = false;
                    return false;
                }
            }
            const remaining = Math.max(0, ctx.toolResultStore.maxArtifactBytes - captureBytes);
            if (remaining <= 0) {
                complete = false;
                return false;
            }
            const buffer = Buffer.from(text, "utf8");
            const writable = buffer.subarray(0, remaining);
            await appendFile(capturePath, writable);
            captureBytes += writable.length;
            if (buffer.length > remaining) {
                complete = false;
                return false;
            }
            return true;
        };

        const appendPaginated = async (result: string): Promise<void> => {
            const index = resultEntries++;
            if (index < offset) return;
            if (head_limit && displayedEntries >= head_limit) return;
            if (complete) await appendResult(result);
        };

        try {
            // 先收集所有要搜的文件
            await walk(searchRoot, glob, files, include_hidden);

            // 逐文件搜索。结果超过 inline 阈值后持续写 capture，而不是停止在第 100 条。
            for (const file of files) {
                throwIfTurnAborted(ctx.signal);
                if (!matchesFileType(file, type)) continue;
                let content: string;
                try {
                    const s = await stat(file);
                    if (s.size > MAX_FILE_SIZE) {
                        skippedCount++;
                        continue;
                    }
                    content = await readFile(file, "utf-8");
                } catch (error) {
                    if (ctx.signal.aborted) throw error;
                    skippedCount++;
                    continue;
                }
                const lines = content.split(/\r?\n/);
                const rel = displayToolPath(ctx.cwd, file);
                const beforeLines = before ?? context;
                const afterLines = after ?? context;
                let fileMatches = 0;

                if (multiline) {
                    const starts = buildLineStarts(content);
                    regex.lastIndex = 0;
                    for (const match of content.matchAll(regex)) {
                        if (fileMatches % 250 === 0) throwIfTurnAborted(ctx.signal);
                        const lineIndex = lineIndexAt(starts, match.index ?? 0);
                        fileMatches++;
                        totalMatches++;
                        if (output_mode === "content") {
                            const formatted = beforeLines > 0 || afterLines > 0
                                ? formatContextBlock(rel, lines, lineIndex, beforeLines, afterLines)
                                : `${rel}:${lineIndex + 1}: ${lines[lineIndex]?.trim() ?? ""}`;
                            await appendPaginated(formatted);
                        }
                    }
                } else {
                    for (let index = 0; index < lines.length; index++) {
                        if (index % 250 === 0) throwIfTurnAborted(ctx.signal);
                        regex.lastIndex = 0;
                        if (!regex.test(lines[index]!)) continue;
                        fileMatches++;
                        totalMatches++;
                        if (output_mode === "content") {
                            const formatted = beforeLines > 0 || afterLines > 0
                                ? formatContextBlock(rel, lines, index, beforeLines, afterLines)
                                : `${rel}:${index + 1}: ${lines[index]!.trim()}`;
                            await appendPaginated(formatted);
                        }
                    }
                }

                if (fileMatches === 0) continue;
                matchedFiles++;
                if (output_mode === "files_with_matches") {
                    await appendPaginated(rel);
                } else if (output_mode === "count") {
                    await appendPaginated(`${rel}: ${fileMatches}`);
                }
            }

            if (totalMatches === 0) {
                return `未找到匹配 /${pattern}/`;
            }

            const pagination = displayedEntries < resultEntries
                ? `，显示 offset=${offset} 后的 ${displayedEntries}/${resultEntries} 条结果`
                : "";
            const modeSummary = output_mode === "content"
                ? `共 ${totalMatches} 条匹配`
                : `共 ${matchedFiles} 个匹配文件、${totalMatches} 条匹配`;
            const summary = `${modeSummary}，搜了 ${files.length} 个文件${pagination}${skippedCount > 0 ? `，跳过 ${skippedCount} 个文件` : ""}${complete ? "" : "；达到结果存储上限，结果不完整"}`;
            if (displayedEntries === 0) {
                return `${summary}；当前分页没有可显示结果`;
            }
            if (!capturePath) {
                return `${inlineOutput}\n\n（${summary}）`;
            }

            const persisted = await ctx.toolResultStore.promoteFile({
                toolCallId: invocation.toolCallId,
                toolName: "grep",
                sourcePath: capturePath,
                originalByteLength: totalBytes,
                complete,
            });
            return {
                content: summary,
                displayContent: `${persisted.preview}\n\n（${summary}）`,
                persisted,
            };
        } finally {
            if (capturePath) {
                await ctx.toolResultStore.removeTemporaryFile(capturePath);
            }
        }
    },
};
