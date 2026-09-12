import {realpath} from "node:fs/promises";
import {dirname, isAbsolute, posix, relative, resolve} from "node:path";
import picomatch from "picomatch";
import type {PermissionMatcher} from "../tools/types.js";
import type {PermissionRules} from "./types.js";

export function isFilePermissionTool(name: string): boolean {
    return ["read_file", "write_file", "edit_file", "delete_file", "view_image", "grep", "glob", "list_files"].includes(name);
}

export function validateFilePattern(pattern: string): boolean {
    if (!pattern || pattern.length > 4096 || /[\x00\r\n]/.test(pattern) || pattern.startsWith("~") || pattern.startsWith('{"') || pattern.endsWith(":*")) return false;
    try {
        picomatch(pattern.replaceAll("\\", "/"), {dot: true, nonegate: true, strictBrackets: true});
        return true;
    } catch { return false; }
}

/** Missing write targets inherit the canonical identity of their existing parent. */
export async function resolveFilePermissionPath(cwd: string, path: string): Promise<string> {
    const target = resolve(cwd, path);
    let existing = target;
    while (true) {
        try { return resolve(await realpath(existing), relative(existing, target)); }
        catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT" || dirname(existing) === existing) throw error;
            existing = dirname(existing);
        }
    }
}

async function patternMatcher(cwd: string, pattern: string): Promise<(path: string) => boolean> {
    if (!validateFilePattern(pattern)) throw new Error("File permission rules must be absolute paths or project-relative globs; JSON, ~ and Bash-prefix syntax are not accepted");
    const normalized = posix.normalize(pattern.replaceAll("\\", "/"));
    const magic = normalized.search(/[*?\[\]{}(]/);
    if (magic < 0) {
        const paths = new Set([resolve(cwd, normalized), await resolveFilePermissionPath(cwd, normalized)]);
        return path => paths.has(path);
    }
    // Resolve only the literal prefix; never interpret the project path as glob syntax.
    const slash = normalized.lastIndexOf("/", magic);
    const prefix = slash < 0 ? "." : normalized.slice(0, slash) || "/";
    const suffix = normalized.slice(slash + 1);
    const roots = [...new Set([resolve(cwd, prefix), await resolveFilePermissionPath(cwd, prefix)])];
    const match = picomatch(suffix, {dot: true, nonegate: true, strictBrackets: true});
    return path => roots.some(root => {
        const rel = relative(root, path).replaceAll("\\", "/");
        if (!rel) return suffix === "**" || suffix === "**/";
        return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && match(rel);
    });
}

async function prepareFileMatcher(cwd: string, patterns: readonly string[]) {
    const compiled = new Map(await Promise.all([...new Set(patterns)].map(async pattern =>
        [pattern, await patternMatcher(cwd, pattern)] as const)));
    return async (path: string): Promise<PermissionMatcher> => {
        const paths = [...new Set([resolve(cwd, path), await resolveFilePermissionPath(cwd, path)])];
        return (pattern, behavior) => {
            const match = compiled.get(pattern);
            if (!match) throw new Error("File rule was not prepared for permission matching");
            return behavior === "allow" ? paths.every(match) : paths.some(match);
        };
    };
}

export async function createFilePermissionMatcher(cwd: string, path: string, patterns: readonly string[]): Promise<PermissionMatcher> {
    return (await prepareFileMatcher(cwd, patterns))(path);
}

/** Descendant ask rules need a later explicit call; searching a parent never grants them. */
export function createSearchPathFilter(cwd: string, root: string, name: string, rules: PermissionRules): (path: string) => Promise<boolean> {
    const denied = rules.deny.filter(rule => rule.toolName === name && rule.content !== undefined);
    const asked = rules.ask.filter(rule => rule.toolName === name && rule.content !== undefined);
    let prepared: ReturnType<typeof prepareFileMatcher> | undefined;
    let restrictions: Promise<typeof denied> | undefined;
    return async path => {
        if (resolve(path) === resolve(root) || (denied.length === 0 && asked.length === 0)) return true;
        const getMatcher = await (prepared ??= prepareFileMatcher(cwd, [...denied, ...asked].map(rule => rule.content!)));
        restrictions ??= getMatcher(root).then(match =>
            [...denied, ...asked.filter(rule => !match(rule.content!, "deny"))]);
        const restricted = await restrictions;
        if (restricted.length === 0) return true;
        const match = await getMatcher(path);
        return !restricted.some(rule => match(rule.content!, "deny"));
    };
}
