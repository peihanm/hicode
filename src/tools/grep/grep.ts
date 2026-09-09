import {checkMemoryStoragePath} from "../../memory/publicationAccess.js";
import {z} from "zod";
import {appendFile, lstat, open} from "node:fs/promises";
import {constants} from "node:fs";
import type {Tool} from "../types.js";
import {createFileDiscovery, createPathMatcher} from "../shared/fileDiscovery.js";
import {createSearchPathFilter} from "../../permissions/filePattern.js";
import {basename, extname, relative} from "node:path";
import {displayToolPath, resolveToolPath} from "../shared/paths.js";
import {throwIfTurnAborted} from "../../runtime/abort.js";
import {resolveSessionArchiveFile} from "../../session/archiveAccess.js";
import {createGrepMatcher} from "./matcher.js";
import type {SearchHit, SearchResponse} from "./protocol.js";

const INLINE_RESULT_CHARS = 20_000;
const MAX_DISCOVERY_FILE_SIZE = 1024 * 1024;
const MAX_EXPLICIT_FILE_SIZE = 64 * 1024 * 1024;
const MAX_LINE_CHARS = 2_000;
const SEARCH_DEADLINE_MS = 30_000;
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
    include_ignored: z.boolean().default(false).describe("包含 .gitignore 与默认 node_modules 排除的文件"),
    search_mode: z.enum(["fast", "complete"]).default("fast").describe("fast 达到 head_limit 后停止；complete 继续统计全部匹配。两者都有文件数和读取字节硬上限，未覆盖部分会明确标注"),
    pattern: z.string().max(4_000).describe("JavaScript 正则表达式；独立 worker 执行，单文件最多 5 秒、整次搜索最多 30 秒"),
    path: z.string().default(".").describe("搜索起始目录或文件"),
    glob: z
        .string()
        .optional()
        .describe("文件名或路径 glob，如 *.ts、src/**/*.{ts,tsx}；支持逗号分隔多个模式"),
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
        .describe("最多显示多少条结果；0 或不传使用 10000 条安全上限，大范围搜索建议设置更小值"),
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

function linePreview(content: string, start: number, end: number, match = start): string {
    if (end - start <= MAX_LINE_CHARS) return content.slice(start, end).replace(/\r$/, "");
    let from = Math.max(start, Math.min(match - MAX_LINE_CHARS / 2, end - MAX_LINE_CHARS));
    let to = Math.min(end, from + MAX_LINE_CHARS);
    const splitsPair = (index: number) => /[\uD800-\uDBFF]/.test(content.charAt(index - 1)) && /[\uDC00-\uDFFF]/.test(content.charAt(index));
    if (splitsPair(from)) from++;
    if (splitsPair(to)) to--;
    return `[长行片段，UTF-16 列 ${from - start + 1}–${to - start}/${end - start}] ${from > start ? "…" : ""}${content.slice(from, to)}${to < end ? "…" : ""}`;
}

function formatHit(rel: string, content: string, hit: SearchHit, before: number, after: number): string {
    const preview = linePreview(content, hit.start, hit.end, hit.match);
    if (!before && !after) return `${rel}:${hit.line}: ${preview.trim()}`;
    const preceding: string[] = [];
    let start = hit.start;
    for (let n = 1; n <= before && start > 0; n++) {
        const end = start - 1;
        start = end === 0 ? 0 : content.lastIndexOf("\n", end - 1) + 1;
        preceding.unshift(` ${formatLineNumber(hit.line - n)}\t${linePreview(content, start, end)}`);
    }
    const out = [`${rel}:${hit.line}`, ...preceding, `>${formatLineNumber(hit.line)}\t${preview}`];
    let end = content.indexOf("\n", hit.end);
    for (let n = 1; n <= after && end !== -1; n++) {
        start = end + 1;
        end = content.indexOf("\n", start);
        out.push(` ${formatLineNumber(hit.line + n)}\t${linePreview(content, start, end === -1 ? content.length : end)}`);
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

export const grepTool: Tool<typeof inputSchema> = {
    name: "grep",
    description: [
        "强大的文件内容正则搜索工具。当任务是寻找代码位置、字面量、配置值或大文件中的目标时，先用 grep 缩小范围，不要盲目分段读取。",
        "目录扫描跳过超过 1 MiB 的文件；明确指定文件可搜索至 64 MiB。超长行显示命中附近的 2000 字符窗口和行内列范围。",
        "默认 content 模式返回文件、行号和匹配行；支持 files_with_matches/count、glob/type、上下文、分页和 multiline。",
        "已经明确具体小文件且需要整体理解时，可以直接 read_file；需要类型语义时运行项目已有的类型检查、编译器或测试。",
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
            include_ignored,
            search_mode,
        }: Input,
        ctx,
        invocation
    ) => {
        const searchRoot = resolveToolPath(ctx.cwd, path);
        await resolveSessionArchiveFile(ctx.storage, ctx.sessionArchives, searchRoot);
        if (await checkMemoryStoragePath(ctx.storage, searchRoot)) {
            if (!ctx.memoryFiles) throw new Error("当前 Agent 无 Memory 读取能力");
            await ctx.memoryFiles.prepare(searchRoot, "grep");
        }
        const explicitFile = (await lstat(searchRoot)).isFile();
        const maxFileSize = explicitFile ? MAX_EXPLICIT_FILE_SIZE : MAX_DISCOVERY_FILE_SIZE;
        const startedAt = performance.now();
        const limit = head_limit || MAX_HEAD_LIMIT;
        const matcher = glob ? createPathMatcher(glob, true) : undefined;
        const discovery = createFileDiscovery({cwd: ctx.cwd, root: searchRoot, signal: ctx.signal,
            canVisit: createSearchPathFilter(ctx.cwd, searchRoot, "grep", ctx.permissionRules),
            includeHidden: include_hidden, includeIgnored: include_ignored,
            maxEntries: search_mode === "fast" ? 20_000 : 100_000});
        const fileLimit = search_mode === "fast" ? 2_000 : 20_000;
        const byteLimit = (search_mode === "fast" ? (explicitFile ? 64 : 32) : 256) * 1024 * 1024;
        let scannedFiles = 0;
        let scannedBytes = 0;
        let searchIncomplete = false;
        let inlineOutput = "";
        let capturePath: string | undefined;
        let totalBytes = 0;
        let captureBytes = 0;
        let totalMatches = 0;
        let matchedFiles = 0;
        let resultEntries = 0;
        let displayedEntries = 0;
        let skippedCount = 0;
        let oversizedCount = 0;
        let searchError: string | undefined;
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
            if (displayedEntries >= limit) return;
            if (complete) await appendResult(result);
        };

        const engine = createGrepMatcher(ctx.signal);
        try {
            const validated = await engine.search({content: "", pattern, ignoreCase: ignore_case, multiline, offset: 0, limit: 0}, SEARCH_DEADLINE_MS);
            if (validated.kind === "invalid_pattern") return {content: `正则表达式不合法: ${validated.message}`, outcome: "failed"};
            for await (const file of discovery.files) {
                throwIfTurnAborted(ctx.signal);
                if (performance.now() - startedAt >= SEARCH_DEADLINE_MS) { searchError = "Grep 搜索达到 30 秒时限，未完成扫描"; searchIncomplete = true; break; }
                await resolveSessionArchiveFile(ctx.storage, ctx.sessionArchives, file);
                await ctx.toolResultFiles.resolveFile(file);
                if (await checkMemoryStoragePath(ctx.storage, file)) {
                    if (!ctx.memoryFiles?.classify(file)) { skippedCount++; continue; }
                    await ctx.memoryFiles.prepare(file, "grep");
                }
                if (matcher && !matcher(relative(searchRoot, file) || basename(file))) continue;
                if (!matchesFileType(file, type)) continue;
                if (scannedFiles >= fileLimit || scannedBytes >= byteLimit) { searchIncomplete = true; break; }
                let content: string;
                let handle;
                try {
                    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                    const info = await handle.stat();
                    if (!info.isFile()) { skippedCount++; continue; }
                    if (info.size > maxFileSize) { skippedCount++; oversizedCount++; continue; }
                    if (scannedBytes + info.size > byteLimit) { searchIncomplete = true; break; }
                    const bytes = Buffer.alloc(Math.min(info.size, maxFileSize, byteLimit - scannedBytes) + 1);
                    let bytesRead = 0;
                    while (bytesRead < bytes.length) {
                        throwIfTurnAborted(ctx.signal);
                        const chunk = await handle.read(bytes, bytesRead, Math.min(64 * 1024, bytes.length - bytesRead), bytesRead);
                        if (chunk.bytesRead === 0) break;
                        bytesRead += chunk.bytesRead;
                    }
                    scannedFiles++;
                    scannedBytes += bytesRead;
                    if (bytesRead === bytes.length || bytesRead > maxFileSize || scannedBytes > byteLimit) { skippedCount++; continue; }
                    if (bytes.subarray(0, bytesRead).includes(0)) { skippedCount++; continue; }
                    content = bytes.subarray(0, bytesRead).toString("utf8");
                } catch (error) {
                    if (ctx.signal.aborted) throw error;
                    skippedCount++;
                    continue;
                } finally { await handle?.close(); }
                const rel = displayToolPath(ctx.cwd, file);
                let found: SearchResponse;
                try {
                    found = await engine.search({content, pattern, ignoreCase: ignore_case, multiline,
                        offset: Math.max(0, offset - resultEntries),
                        limit: output_mode === "content" ? Math.max(0, limit - displayedEntries) : 0,
                    }, SEARCH_DEADLINE_MS - (performance.now() - startedAt));
                } catch (error) {
                    throwIfTurnAborted(ctx.signal);
                    searchError = error instanceof Error ? error.message : String(error);
                    searchIncomplete = true;
                    break;
                }
                if (found.kind === "invalid_pattern") { searchError = found.message; searchIncomplete = true; break; }
                const fileMatches = found.count;
                totalMatches += fileMatches;
                if (output_mode === "content") {
                    resultEntries += fileMatches;
                    for (const hit of found.hits) {
                        throwIfTurnAborted(ctx.signal);
                        if (!await appendResult(formatHit(rel, content, hit, before ?? context, after ?? context))) break;
                    }
                }

                if (fileMatches === 0) continue;
                matchedFiles++;
                if (output_mode === "files_with_matches") {
                    await appendPaginated(rel);
                } else if (output_mode === "count") {
                    await appendPaginated(`${rel}: ${fileMatches}`);
                }
                if (!complete || (search_mode === "fast" && displayedEntries >= limit)) {
                    searchIncomplete = true;
                    break;
                }
            }

            const stats = discovery.getStats();
            searchIncomplete ||= stats.truncated || skippedCount > 0;
            const coverage = `搜了 ${scannedFiles} 个文件（${scannedBytes} 字节），发现 ${stats.candidateFiles} 个候选文件`;
            const incomplete = searchIncomplete
                ? `；搜索未完整覆盖，仅报告已扫描范围${stats.issues.length ? `：${stats.issues.join("；")}` : ""}。${oversizedCount ? `跳过 ${oversizedCount} 个超过 ${maxFileSize / 1024 / 1024} MiB 的文件${explicitFile ? "，需先缩小文件" : "，可指定具体文件（上限 64 MiB）"}。` : ""}${explicitFile ? "" : "可缩小 path 或使用 search_mode=complete"}`
                : "";
            if (totalMatches === 0 && searchError) return {content: `${searchError}（${coverage}）；不能据此判断没有匹配`, outcome: "failed"};
            if (totalMatches === 0) {
                return `未找到匹配 /${pattern}/（${coverage}${skippedCount ? `，跳过 ${skippedCount} 个文件` : ""}${incomplete}）`;
            }

            const pagination = displayedEntries < resultEntries
                ? `，显示 offset=${offset} 后的 ${displayedEntries}/${resultEntries} 条结果`
                : "";
            const modeSummary = output_mode === "content"
                ? `共 ${totalMatches} 条匹配`
                : `共 ${matchedFiles} 个匹配文件、${totalMatches} 条匹配`;
            const summary = `${modeSummary}，${coverage}${pagination}${skippedCount > 0 ? `，跳过 ${skippedCount} 个文件` : ""}${complete ? "" : "；达到结果存储上限，结果不完整"}${incomplete}${searchError ? `；${searchError}` : ""}`;
            if (displayedEntries === 0) {
                return {content: `${summary}；当前分页没有可显示结果`, outcome: searchError ? "failed" : "ok"};
            }
            if (!capturePath) {
                return {content: `${inlineOutput}\n\n（${summary}）`, outcome: searchError ? "failed" : "ok"};
            }

            const persisted = await ctx.toolResultStore.promoteFile({
                toolCallId: invocation.toolCallId,
                toolName: "grep",
                sourcePath: capturePath,
                originalByteLength: totalBytes,
                complete: complete && !searchIncomplete,
            });
            return {
                content: summary,
                outcome: searchError ? "failed" : "ok",
                displayContent: `${persisted.preview}\n\n（${summary}）`,
                persisted,
            };
        } finally {
            await engine.close();
            if (capturePath) {
                await ctx.toolResultStore.removeTemporaryFile(capturePath);
            }
        }
    },
};
