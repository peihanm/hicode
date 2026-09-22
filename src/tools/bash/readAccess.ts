import {dirname, resolve} from "node:path";
import {realpath, lstat} from "node:fs/promises";
import {analyzeReadCommand, type ReadCommand} from "../../permissions/shellRead.js";
import {createFilePermissionMatcher, resolveFilePermissionPath} from "../../permissions/filePattern.js";
import {isPathInside, validateWorkspacePath} from "../../permissions/pathGuard.js";
import {checkMemoryStoragePath} from "../../memory/publicationAccess.js";
import {checkSessionArchivePath, resolveSessionArchiveFile} from "../../session/archiveAccess.js";
import type {ToolContext} from "../types.js";

export interface CommandReadAccess {
    plan: ReadCommand;
    paths: string[];
    artifacts: string[];
    artifactDirectories: string[];
    deniedPaths: string[];
    privateRoot: string;
    projectRoot: string;
}

/** Preparing a view or validating a result grants only that exact managed file for this invocation. */
export async function prepareCommandReadAccess(command: string, cwd: string, ctx: ToolContext): Promise<CommandReadAccess | undefined> {
    const plan = analyzeReadCommand(command);
    const restricted = ctx.readOnlyTools || ctx.collaborationMode === "plan";
    if (!plan) {
        if (restricted) throw new Error("Read-only commands must use rg, ls, pwd, cat, head, tail, wc or echo with literal arguments; use read_file for other reads. Shell expansion, redirection and executing other programs are not allowed.");
        return undefined;
    }
    if (plan.paths.length > 128) throw new Error("Too many search paths; narrow the command");
    const privateRoot = await resolveFilePermissionPath(ctx.cwd, ctx.storage.hicodeHome);
    // The Host ceiling may be filesystem root; it is not the project supplying untrusted programs.
    const projectRoot = await realpath(ctx.cwd);
    const paths: string[] = [];
    const artifacts: string[] = [];
    const artifactDirectories: string[] = [];
    const deniedPaths: string[] = [];
    const rules = [...ctx.permissionRules.deny, ...ctx.permissionRules.ask].filter(rule => rule.toolName === "read_file");
    if (rules.some(rule => rule.content === undefined)) throw new Error("File reading is restricted by an explicit read_file rule; command search cannot bypass it");
    for (const rule of rules) {
        const raw = rule.content!.replace(/\/\*\*\/?$/, "");
        // A literal denial maps exactly to a Sandbox subpath; unsupported patterns fail closed.
        if (/[*?\[\]{}()]/.test(raw)) throw new Error("Command search cannot safely enforce this read_file path pattern; use an exact read_file request or configure Sandbox filesystem denyRead");
        const path = resolve(ctx.cwd, raw);
        let canonical = path;
        try {canonical = await realpath(path);} catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        deniedPaths.push(path, canonical);
    }
    for (const input of [...new Set(plan.paths)]) {
        ctx.signal.throwIfAborted();
        if (input.includes("\0")) throw new Error("Search paths cannot contain NUL");
        const path = resolve(cwd, input);
        let managed = false;
        let memoryDirectory = false;
        if (await checkMemoryStoragePath(ctx.storage, path)) {
            if (!ctx.memoryFiles) throw new Error("This Agent has no Memory file capability");
            memoryDirectory = !!await ctx.memoryFiles.shellDirectory(path);
            if (!memoryDirectory) await ctx.memoryFiles.prepare(path, "read_file");
            managed = true;
        } else if (await checkSessionArchivePath(ctx.storage, path)) {
            managed = !!await resolveSessionArchiveFile(ctx.storage, ctx.sessionArchives, path);
        } else {
            managed = (await ctx.toolResultFiles.resolveFile(path)) !== null;
        }
        if ((isPathInside(resolve(ctx.storage.hicodeHome), path) || isPathInside(privateRoot, await resolveFilePermissionPath(cwd, path))) && !managed) throw new Error("Search of private HiCode storage requires an exact authorized result, archive or Memory file");
        const match = await createFilePermissionMatcher(ctx.cwd, path, rules.map(rule => rule.content!));
        if (rules.some(rule => match(rule.content!, "deny"))) throw new Error("Search path is restricted by a read_file rule");
        if (managed) {
            const info = await lstat(path);
            if ((!info.isFile() && !(memoryDirectory && info.isDirectory())) || info.isSymbolicLink()) throw new Error("Managed search input must be a regular file, not a symbolic link");
            (memoryDirectory ? artifactDirectories : artifacts).push(await realpath(path));
        } else {
            const within = await validateWorkspacePath(ctx.workspaceBoundary ?? ctx.cwd, cwd, path);
            if (!within.ok && !(ctx.permissionMode === "full-access" && ctx.allowFullAccess && !ctx.workspaceBoundary && !restricted) && !await ctx.directoryAccess.canAccess(path)) throw new Error(within.message);
            // Preserve rg's own missing-path diagnostic; resolve the existing parent for the read grant.
            let existing = path;
            for (;;) {
                try {
                    const canonical = await realpath(existing);
                    paths.push(canonical);
                    // rg reads ancestor ignore files even when the explicit search starts in src/.
                    // Grant only existing regular ignore files inside this Agent's workspace.
                    if (plan.segments.some(segment => segment.program.split("/").at(-1) === "rg")) {
                        let directory = (await lstat(canonical)).isDirectory() ? canonical : dirname(canonical);
                        while (isPathInside(projectRoot, directory)) {
                            for (const name of [".gitignore", ".ignore", ".rgignore", ".git/info/exclude"]) {
                                const ignore = resolve(directory, name);
                                try {
                                    const info = await lstat(ignore);
                                    if (info.isSymbolicLink()) throw new Error("Search ignore files must not be symbolic links");
                                    if (info.isFile()) {
                                        const resolved = await realpath(ignore);
                                        if (!isPathInside(projectRoot, resolved) || isPathInside(privateRoot, resolved)) throw new Error("Search ignore file is outside the authorized workspace");
                                        paths.push(resolved);
                                    }
                                } catch (error) {
                                    if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code)))) throw error;
                                }
                            }
                            if (directory === projectRoot) break;
                            directory = dirname(directory);
                        }
                    }
                    break;
                }
                catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dirname(existing) === existing) throw error;
                    existing = dirname(existing);
                }
            }
        }
    }
    return {plan, paths: [...new Set(paths)], artifacts, artifactDirectories, deniedPaths: [...new Set(deniedPaths)], privateRoot, projectRoot};
}
