import {constants} from "node:fs";
import {lstat, open, opendir, realpath} from "node:fs/promises";
import {dirname, isAbsolute, join, relative, resolve} from "node:path";
import ignore from "ignore";
import picomatch from "picomatch";
import {throwIfTurnAborted} from "../../runtime/abort.js";

interface IgnoreLayer { root: string; rules: ReturnType<typeof ignore> }
interface DiscoveryStats {
    visitedEntries: number;
    candidateFiles: number;
    skippedEntries: number;
    truncated: boolean;
    issues: string[];
}

function inside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}

/** Commas outside brace/character/extension groups retain grep's multiple-pattern syntax. */
export function createPathMatcher(pattern: string, matchBasename = false): (path: string) => boolean {
    const patterns: string[] = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index]!;
        if (char === "\\") { index++; continue; }
        if ("{[(".includes(char)) depth++;
        if ("}])".includes(char)) depth--;
        if (char === "," && depth === 0) { patterns.push(pattern.slice(start, index).trim()); start = index + 1; }
    }
    patterns.push(pattern.slice(start).trim());
    const matchers = patterns.map(pattern => picomatch(pattern, {dot: true, basename: matchBasename && !pattern.includes("/"), nonegate: true, strictBrackets: true}));
    return path => matchers.some(match => match(path.replaceAll("\\", "/")));
}

/** One filesystem view for name and content search; no child process or write capability. */
export function createFileDiscovery(input: {
    cwd: string;
    root: string;
    signal: AbortSignal;
    includeHidden: boolean;
    includeIgnored: boolean;
    maxEntries: number;
    canVisit(path: string): Promise<boolean>;
}) {
    const stats: DiscoveryStats = {visitedEntries: 0, candidateFiles: 0, skippedEntries: 0, truncated: false, issues: []};
    const root = resolve(input.root);
    const cwd = resolve(input.cwd);
    let canonicalRoot: string;
    const issue = (message: string) => {
        stats.truncated = true;
        if (stats.issues.length < 10) stats.issues.push(message);
    };
    const readRules = async (directory: string): Promise<IgnoreLayer | undefined> => {
        if (input.includeIgnored) return undefined;
        const path = join(directory, ".gitignore");
        let handle;
        try {
            if (!await input.canVisit(path)) throw new Error("搜索权限不允许读取 ignore 规则");
            handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            const info = await handle.stat();
            if (!info.isFile() || info.size > 64 * 1024) throw new Error("ignore 文件不是有界 regular file");
            const bytes = Buffer.alloc(64 * 1024 + 1);
            let bytesRead = 0;
            while (bytesRead < bytes.length) {
                throwIfTurnAborted(input.signal);
                const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
                if (chunk.bytesRead === 0) break;
                bytesRead += chunk.bytesRead;
            }
            if (bytesRead > 64 * 1024) throw new Error("ignore 文件超过 64 KiB");
            return {root: directory, rules: ignore({ignorecase: false}).add(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, bytesRead)))};
        } catch (error) {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
            throw new Error(`无法读取搜索 ignore 规则: ${path}`, {cause: error});
        } finally { await handle?.close(); }
    };
    const ignored = (path: string, directory: boolean, layers: readonly IgnoreLayer[]) => {
        if (input.includeIgnored) return false;
        let result = false;
        for (const layer of layers) {
            const rel = relative(layer.root, path).replaceAll("\\", "/");
            if (!rel || !inside(layer.root, path)) continue;
            const tested = layer.rules.test(`${rel}${directory ? "/" : ""}`);
            if (tested.ignored) result = true;
            if (tested.unignored) result = false;
        }
        return result;
    };
    async function* walk(directory: string, inherited: readonly IgnoreLayer[], depth: number): AsyncGenerator<string> {
        throwIfTurnAborted(input.signal);
        if (depth > 64) { issue("目录深度超过 64 层"); return; }
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !inside(canonicalRoot, await realpath(directory))) {
            issue(`目录路径发生改变或越出搜索根: ${relative(root, directory) || "."}`);
            return;
        }
        const local = await readRules(directory);
        const layers = local ? [...inherited, local] : inherited;
        let handle;
        try { handle = await opendir(directory); }
        catch { issue(`无法枚举目录: ${relative(root, directory) || "."}`); return; }
        for await (const entry of handle) {
            throwIfTurnAborted(input.signal);
            if (stats.visitedEntries >= input.maxEntries) { issue(`达到 ${input.maxEntries} 个目录项的扫描上限`); return; }
            stats.visitedEntries++;
            const path = join(directory, entry.name);
            if (entry.name === ".git" || (!input.includeHidden && entry.name.startsWith(".")) ||
                entry.isSymbolicLink() || ignored(path, entry.isDirectory(), layers)) {
                stats.skippedEntries++;
                continue;
            }
            if (!await input.canVisit(path)) {
                stats.skippedEntries++;
                issue("部分路径因 deny/ask 权限规则未扫描；需要确认的路径请单独调用工具");
                continue;
            }
            if (entry.isDirectory()) yield* walk(path, layers, depth + 1);
            else if (entry.isFile()) { stats.candidateFiles++; yield path; }
        }
    }
    async function* files(): AsyncGenerator<string> {
        throwIfTurnAborted(input.signal);
        if (root.split(/[\\/]/).includes(".git")) return;
        const info = await lstat(root);
        if (info.isSymbolicLink()) { issue("搜索根路径是符号链接"); return; }
        // An explicit file is an intentional override of the discovery filters.
        if (info.isFile()) { stats.candidateFiles++; yield root; return; }
        if (!info.isDirectory()) throw new Error("搜索路径不是文件或目录");
        canonicalRoot = await realpath(root);
        const layers: IgnoreLayer[] = [{root: inside(cwd, root) ? cwd : root,
            rules: ignore({ignorecase: false}).add("node_modules/")}];
        if (inside(cwd, root) && root !== cwd && !input.includeIgnored) {
            const ancestors: string[] = [];
            for (let current = dirname(root); inside(cwd, current); current = dirname(current)) {
                ancestors.push(current);
                if (current === cwd) break;
            }
            for (const directory of ancestors.reverse()) {
                const layer = await readRules(directory);
                if (layer) layers.push(layer);
            }
        }
        if (ignored(root, true, layers)) return;
        yield* walk(root, layers, 0);
    }
    return {files: files(), getStats: () => ({...stats, issues: [...stats.issues]})};
}
