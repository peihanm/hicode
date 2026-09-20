import {randomUUID} from "node:crypto";
import {lstat, realpath} from "node:fs/promises";
import {basename, isAbsolute, relative, resolve} from "node:path";
import {setImmediate} from "node:timers/promises";
import {contentText} from "../images/content.js";
import {createFilePermissionMatcher, resolveFilePermissionPath} from "../permissions/filePattern.js";
import {isPathInside} from "../permissions/pathGuard.js";
import {createReadOnlyBashTool} from "../tools/bash/bash.js";
import {prepareCommandReadAccess} from "../tools/bash/readAccess.js";
import {createFileStateTracker} from "../tools/shared/fileState.js";
import {createToolRuntime} from "../tools/runtime.js";
import type {ToolContext} from "../tools/types.js";

const COMMAND = "rg --files --null --hidden -g '!.git' -g '!node_modules' -g '!.env' -g '!.env.*' .";
const MAX_PATHS = 50_000;
const MAX_BYTES = 4 * 1024 * 1024;
const CACHE_MS = 15_000;

export interface FileSuggestionResult {
    paths: string[];
    limited: boolean;
}

function scorePath(path: string, query: string): number | undefined {
    if (!query) return path.split("/").length * 100 + path.length;
    const normalized = path.toLowerCase();
    const name = basename(normalized);
    if (name === query) return -10_000;
    if (name.startsWith(query)) return -5_000 + path.length;
    const contiguous = normalized.indexOf(query);
    if (contiguous >= 0) return -1_000 + contiguous + path.length;
    let position = -1;
    let score = path.length;
    for (const character of query) {
        const next = normalized.indexOf(character, position + 1);
        if (next < 0) return undefined;
        score += (next - position - 1) * 4;
        if (next === 0 || "/_- .".includes(normalized[next - 1]!)) score -= 8;
        position = next;
    }
    return score;
}

/** Session UI owns this cache; Agent searches never consume it. Construction performs no I/O. */
export class FileSuggestions {
    private cache?: {key: string; expires: number; paths: string[]; limited: boolean};
    private pending?: {key: string; controller: AbortController; promise: Promise<FileSuggestionResult>};
    private closed = false;
    private readonly runs = new Set<Promise<FileSuggestionResult>>();
    private revision = 0;
    // A host-only specialization: bounded filename output stays ephemeral, not in Session artifacts.
    private readonly runtime = createToolRuntime({allowedToolNames: ["bash"], toolOverrides: [{
        ...createReadOnlyBashTool(), maxResultSizeChars: MAX_BYTES,
        async execute(input, ctx) {
            const readAccess = await prepareCommandReadAccess(input.command, ctx.cwd, {...ctx, readOnlyTools: true});
            if (!readAccess) throw new Error("File suggestions require a restricted read command");
            const result = await ctx.shellRunner.run({command: input.command, cwd: ctx.cwd, signal: ctx.signal,
                readAccess, timeoutMs: 10_000, maxBuffer: MAX_BYTES, maxOutputBytes: MAX_BYTES});
            const termination = result.termination;
            if (termination.kind !== "exit" || termination.signal || termination.code > 1 || result.stderr.trim()) {
                const reason = termination.kind === "spawn_error" ? termination.error.message
                    : termination.kind === "timeout" ? `File enumeration timed out after ${termination.timeoutMs}ms`
                    : termination.kind === "output_limit" ? `File list exceeds the ${termination.maxBuffer}-byte limit; type a path directly`
                    : termination.kind === "aborted" ? "File enumeration cancelled"
                    : termination.signal ? `File enumeration stopped by ${termination.signal}`
                    : `File enumeration failed (rg exit code ${termination.code})`;
                return {content: [reason, result.stderr.trim()].filter(Boolean).join(": ").slice(0, 240), outcome: "failed"};
            }
            return {content: result.stdout || "\0", outcome: "ok"};
        },
    }]});

    constructor(private readonly createContext: (signal: AbortSignal) => ToolContext) {}

    async search(query: string, signal: AbortSignal): Promise<FileSuggestionResult> {
        signal.throwIfAborted();
        if (this.closed) throw new Error("File suggestions are closed");
        const controller = new AbortController();
        const ctx = this.createContext(controller.signal);
        const key = JSON.stringify([ctx.cwd, ctx.sessionId, ctx.permissionRules, this.revision]);
        let index: FileSuggestionResult;
        if (this.cache?.key === key && this.cache.expires > Date.now()) index = this.cache;
        else {
            if (this.pending?.key !== key) {
                this.cancel();
                const timer = setTimeout(() => controller.abort(new Error("File enumeration timed out after 10000ms")), 10_000);
                const promise = this.load(ctx).then(result => {
                    if (!controller.signal.aborted && !this.closed && this.pending?.key === key)
                        this.cache = {...result, key, expires: Date.now() + CACHE_MS};
                    return result;
                }).finally(() => {
                    clearTimeout(timer);
                    this.runs.delete(promise);
                    if (this.pending?.controller === controller) this.pending = undefined;
                });
                this.runs.add(promise);
                this.pending = {key, controller, promise};
            }
            index = await this.pending!.promise;
        }
        signal.throwIfAborted();
        const revision = this.revision;
        const needle = query.toLowerCase().replace(/^\.\//, "").slice(0, 256);
        const best: Array<{path: string; score: number}> = [];
        for (let i = 0; i < index.paths.length; i++) {
            if (i % 512 === 0) {
                await setImmediate(); signal.throwIfAborted();
                if (this.closed || this.revision !== revision) throw new Error("File suggestions changed");
            }
            const path = index.paths[i]!;
            const score = scorePath(path, needle);
            if (score === undefined) continue;
            best.push({path, score});
            best.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
            if (best.length > 8) best.pop();
        }
        return {paths: best.map(entry => entry.path), limited: index.limited};
    }

    private async load(ctx: ToolContext): Promise<FileSuggestionResult> {
        const root = await realpath(ctx.cwd);
        const privateRoot = await resolveFilePermissionPath(ctx.cwd, ctx.storage.hicodeHome);
        const privateRelative = relative(root, privateRoot);
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        const escaped = privateRelative.replace(/[\[\]*?{}]/g, value => `[${value}]`);
        const command = COMMAND + (isPathInside(root, privateRoot) && privateRelative ? ` -g ${quote(`!/${escaped}`)}` : "");
        if (!ctx.toolNames.includes("bash")) throw new Error("This session does not allow file enumeration");
        const result = await this.runtime.executeTool("bash", JSON.stringify({command, timeout_ms: 10_000}), {...ctx, fileState: createFileStateTracker()}, `file-suggestions:${randomUUID()}`);
        ctx.signal.throwIfAborted();
        if (result.outcome !== "ok") throw new Error(contentText(result.modelContent).slice(0, 240));
        const text = contentText(result.modelContent);
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Project file list is too large; type a path directly");
        if (text && !text.endsWith("\0")) throw new Error("Incomplete file suggestion output");
        const rules = [...ctx.permissionRules.deny, ...ctx.permissionRules.ask].filter(rule => rule.toolName === "read_file");
        const paths: string[] = [];
        const candidates = [...new Set(text.split("\0").filter(Boolean))];
        // Do not turn terminal control characters or symlink destinations into selectable paths.
        for (let i = 0; i < Math.min(candidates.length, MAX_PATHS); i++) {
            ctx.signal.throwIfAborted();
            const path = candidates[i]!.replace(/^\.\//, "");
            if (isAbsolute(path) || path.split("/").includes("..") || /[\x00-\x1f\x7f-\x9f]/.test(path)) continue;
            const absolute = resolve(root, path);
            if (isPathInside(privateRoot, absolute)) continue;
            if (rules.length) {
                const match = await createFilePermissionMatcher(ctx.cwd, absolute, rules.flatMap(rule => rule.content === undefined ? [] : [rule.content]));
                if (rules.some(rule => rule.content === undefined || match(rule.content, "deny"))) continue;
            }
            try {
                const info = await lstat(absolute);
                if (!info.isFile() || info.isSymbolicLink()) continue;
                const canonical = await realpath(absolute);
                if (!isPathInside(root, canonical) || isPathInside(privateRoot, canonical)) continue;
                paths.push(path);
            } catch (error) {
                if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))) throw error;
            }
        }
        return {paths, limited: candidates.length > MAX_PATHS};
    }

    cancel(): void {this.pending?.controller.abort("file-suggestions-dismissed"); this.pending = undefined;}
    invalidate(): void {this.revision++; this.cache = undefined; this.cancel();}
    async close(): Promise<void> {
        this.closed = true;
        this.invalidate();
        await Promise.allSettled(this.runs);
    }
}
