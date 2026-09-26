import {realpath, stat} from "node:fs/promises";
import {dirname, isAbsolute, join} from "node:path";
import {getApplySeccompBinaryPath} from "@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js";
import {resolveFilePermissionPath} from "../permissions/filePattern.js";
import {isPathInside} from "../permissions/pathGuard.js";
import type {ReadOnlyAccess} from "./readOnly.js";

/** Build an empty filesystem and mount only granted inputs, never a read-only copy of the host root. */
export async function linuxFileScopeArgv(command: string, access: ReadOnlyAccess, denials: readonly string[], cwd: string,
    workspace?: {root: string; writable: boolean; deniedWrites: readonly string[]}): Promise<string[]> {
    const applySeccomp = getApplySeccompBinaryPath();
    if (!applySeccomp) throw new Error("Restricted Linux commands require the bundled apply-seccomp executable");
    if (workspace && isPathInside(workspace.root, access.privateRoot)) {
        throw new Error("A file workspace cannot contain the private HiCode storage root");
    }
    const checked = (path: string) => {
        if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error("Linux Sandbox paths must be absolute");
        return path;
    };
    const args = ["bwrap", "--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL",
        "--dir", checked(cwd)];
    const maskedDirectories = new Set<string>();
    const mountedPaths: string[] = [];
    const optionalStat = async (path: string) => stat(path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    });
    const bind = async (path: string, writable = false) => {
        checked(path);
        const canonical = await realpath(path);
        args.push(writable ? "--bind" : "--ro-bind", canonical, path);
        mountedPaths.push(canonical);
    };
    // rg discovers repository roots from ancestor .git metadata before honoring .gitignore.
    // Supply only the marker, not the repository's private Git contents.
    for (let directory = cwd; ; directory = dirname(directory)) {
        const marker = join(directory, ".git");
        const info = await optionalStat(marker);
        if (info?.isDirectory()) args.push("--dir", marker);
        else if (info?.isFile()) args.push("--ro-bind", "/dev/null", marker);
        if (directory === dirname(directory)) break;
    }
    // Runtime loaders/libraries are readable; only selected program files are mounted.
    for (const path of ["/usr/lib", "/usr/lib64", "/lib", "/lib64", "/etc/ld.so.cache"]) {
        if (await optionalStat(path)) await bind(path);
    }
    for (const path of [...new Set(["/bin/bash", applySeccomp, ...access.executables])]) await bind(path);
    for (const path of [...new Set(access.paths)].sort((a, b) => a.length - b.length)) await bind(path);

    const mask = async (path: string, writeOnly = false) => {
        checked(path);
        // Mount masks cannot enforce future glob matches. Refuse rather than approximate a deny rule.
        if (/[*?\[\]{}()!\\]/.test(path)) throw new Error("Linux scoped file commands require literal deny paths; use file tools for glob-restricted paths");
        let canonical = await resolveFilePermissionPath(cwd, path);
        if (writeOnly) {
            if (!workspace?.writable) return;
            if (isPathInside(canonical, workspace.root)) canonical = workspace.root;
            else if (!isPathInside(workspace.root, canonical)) return;
        }
        const info = await optionalStat(canonical);
        if (!info) {
            // Absent default credential directories outside the visible tree need no mount.
            if (!mountedPaths.some(root => isPathInside(root, canonical))) return;
            throw new Error(`Cannot enforce a missing deny path in a Linux file scope: ${path}`);
        }
        if (writeOnly) args.push("--ro-bind", canonical, canonical);
        else if (info.isDirectory()) {
            args.push("--tmpfs", canonical);
            maskedDirectories.add(canonical);
        }
        else args.push("--ro-bind", "/dev/null", canonical);
    };
    // Hide private storage even when the caller was granted one of its ancestors.
    await mask(access.privateRoot);
    for (const path of [...access.artifacts, ...access.artifactDirectories]) await bind(path);
    if (workspace) await bind(workspace.root, workspace.writable);
    // A broad authorized read (including /) must never restore the host's proc or devices.
    args.push("--proc", "/proc", "--dev", "/dev");
    // Write denies precede read masks so they cannot bind hidden contents back into view.
    for (const path of workspace?.deniedWrites ?? []) await mask(path, true);
    for (const path of [...access.deniedPaths, ...denials].sort((a, b) => a.length - b.length)) await mask(path);
    for (const path of maskedDirectories) args.push("--remount-ro", path);
    args.push("--remount-ro", "/", "--chdir", checked(cwd), "--", applySeccomp,
        "/bin/bash", "--noprofile", "--norc", "-c", command);
    return args;
}
