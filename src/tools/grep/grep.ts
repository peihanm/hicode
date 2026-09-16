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
    include_ignored: z.boolean().default(false).describe("Include files excluded by .gitignore and the default node_modules filter."),
    search_mode: z.enum(["fast", "complete"]).default("fast").describe("fast stops at head_limit; complete continues counting matches. Both have file/byte caps and report incomplete coverage."),
    pattern: z.string().max(4_000).describe("JavaScript regex in an isolated worker; capped at 5 seconds per file and 30 seconds per search."),
    path: z.string().default(".").describe("Directory or file to search."),
    glob: z
        .string()
        .optional()
        .describe("Filename/path glob such as *.ts or src/**/*.{ts,tsx}; supports comma-separated patterns."),
    type: z
        .string()
        .optional()
        .describe("Filter by common type: ts, js, py, rust, go, html, css."),
    output_mode: z
        .enum(["content", "files_with_matches", "count"])
        .default("content")
        .describe("Return matching content, matching file paths or counts per file."),
    context: z
        .number()
        .int()
        .min(0)
        .max(MAX_CONTEXT)
        .default(0)
        .describe("Context lines before and after each match; default 0, maximum 10."),
    before: z
        .number()
        .int()
        .min(0)
        .max(MAX_CONTEXT)
        .optional()
        .describe("Lines before each match; overrides context for preceding lines."),
    after: z
        .number()
        .int()
        .min(0)
        .max(MAX_CONTEXT)
        .optional()
        .describe("Lines after each match; overrides context for following lines."),
    ignore_case: z.boolean().default(false).describe("Case-insensitive matching."),
    multiline: z
        .boolean()
        .default(false)
        .describe("Allow multiline matches; dot can match newlines when enabled."),
    head_limit: z
        .number()
        .int()
        .min(0)
        .max(MAX_HEAD_LIMIT)
        .optional()
        .describe("Maximum displayed results; 0 or omitted uses the 10000 safety cap. Prefer smaller limits for broad searches."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Skip N results; combine with head_limit for pagination."),
    include_hidden: z
        .boolean()
        .default(false)
        .describe("Search hidden paths such as .github/.hicode; default false. Always excludes .git."),
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
    return `[Long-line excerpt, UTF-16 columns ${from - start + 1}–${to - start}/${end - start}] ${from > start ? "…" : ""}${content.slice(from, to)}${to < end ? "…" : ""}`;
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
    description: "Search file contents with a regular expression. Use targeted searches to locate symbols, configuration and failures in saved output, then read relevant source. Directory scans skip files over 1 MiB; an explicit file supports up to 64 MiB. Long lines show a 2000-character window around the match and column ranges. content returns paths, lines and matches; files_with_matches/count, glob/type filters, context, pagination and multiline are available. Known small files can be read directly. Regex search is not type-aware analysis; use project compilers/checks when needed.",
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
            if (!ctx.memoryFiles) throw new Error("This Agent has no Memory read capability");
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
            if (validated.kind === "invalid_pattern") return {content: `Invalid regular expression: ${validated.message}`, outcome: "failed"};
            for await (const file of discovery.files) {
                throwIfTurnAborted(ctx.signal);
                if (performance.now() - startedAt >= SEARCH_DEADLINE_MS) { searchError = "Grep reached the 30-second limit; scan incomplete"; searchIncomplete = true; break; }
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
            const coverage = `Searched ${scannedFiles} files (${scannedBytes} bytes); found ${stats.candidateFiles} candidate files`;
            const incomplete = searchIncomplete
                ? `; search coverage is incomplete; only scanned paths are reported ${stats.issues.length ? `:${stats.issues.join(";")}` : ""}.${oversizedCount ? `Skipped ${oversizedCount} files exceeding ${maxFileSize / 1024 / 1024} MiB ${explicitFile ? "; narrow the file first" : "; specify an exact file (up to 64 MiB)"}.` : ""}${explicitFile ? "" : "Narrow path or use search_mode=complete"}`
                : "";
            if (totalMatches === 0 && searchError) return {content: `${searchError}(${coverage}); this does not establish that no matches exist`, outcome: "failed"};
            if (totalMatches === 0) {
                return `No matches for /${pattern}/(${coverage}${skippedCount ? `; skipped ${skippedCount} files` : ""}${incomplete})`;
            }

            const pagination = displayedEntries < resultEntries
                ? `; showing offset=${offset}: ${displayedEntries}/${resultEntries} results`
                : "";
            const modeSummary = output_mode === "content"
                ? `Total: ${totalMatches} matches`
                : `Total: ${matchedFiles} matching files,${totalMatches} matches`;
            const summary = `${modeSummary},${coverage}${pagination}${skippedCount > 0 ? `; skipped ${skippedCount} files` : ""}${complete ? "" : "; result storage limit reached; results are incomplete"}${incomplete}${searchError ? `;${searchError}` : ""}`;
            if (displayedEntries === 0) {
                return {content: `${summary}; no results on this page`, outcome: searchError ? "failed" : "ok"};
            }
            if (!capturePath) {
                return {content: `${inlineOutput}\n\n(${summary})`, outcome: searchError ? "failed" : "ok"};
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
                displayContent: `${persisted.preview}\n\n(${summary})`,
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
