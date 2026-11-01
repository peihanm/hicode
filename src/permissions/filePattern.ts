import {isAbsolute, posix, relative, resolve} from "node:path";
import picomatch from "picomatch";
import type {PermissionMatcher} from "../tools/types.js";
import {resolveFilePermissionPath} from "./pathGuard.js";

export function isFilePermissionTool(name: string): boolean {
    return ["read_file", "write_file", "edit_file", "view_image"].includes(name);
}

export function validateFilePattern(pattern: string): boolean {
    if (!pattern || pattern.length > 4096 || /[\x00\r\n]/.test(pattern) || pattern.startsWith("~") || pattern.startsWith('{"') || pattern.endsWith(":*")) return false;
    try {
        picomatch(pattern.replaceAll("\\", "/"), {dot: true, nonegate: true, strictBrackets: true});
        return true;
    } catch { return false; }
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

export async function createFilePermissionMatcher(cwd: string, path: string, patterns: readonly string[]): Promise<PermissionMatcher> {
    const compiled = new Map(await Promise.all([...new Set(patterns)].map(async pattern =>
        [pattern, await patternMatcher(cwd, pattern)] as const)));
    const paths = [...new Set([resolve(cwd, path), await resolveFilePermissionPath(cwd, path)])];
    return (pattern, behavior) => {
        const match = compiled.get(pattern);
        if (!match) throw new Error("File rule was not prepared for permission matching");
        return behavior === "allow" ? paths.every(match) : paths.some(match);
    };
}
