import {lstat, opendir, realpath, stat} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {SandboxRuntimeConfig} from "@anthropic-ai/sandbox-runtime";
import {isPathInside} from "../permissions/pathGuard.js";
import type {MaskedFileStore} from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-mask-files.js";
import type {LinuxSandboxParams} from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";

/** Preserve absent .env write protection without exposing a character device to dotenv readers. */
async function protectedRoots(roots: readonly string[]): Promise<string[]> {
    if (!roots.length) throw new Error("Linux Sandbox requires a workspace root");
    const temporaryRoots = new Set(await Promise.all(["/tmp", tmpdir()].map(path => realpath(path))));
    const canonical = await Promise.all(roots.map(path => realpath(path)));
    // Shared temporary grants are scratch space, not projects. Never scan other
    // users' temp trees; an explicit primary workspace there still gets protection.
    const projects = [...new Set(canonical.filter((path, index) => index === 0 || !temporaryRoots.has(path)))];
    if (projects.some(path => /[*?\[\]{}()!\\]/.test(path))) {
        throw new Error("Linux Sandbox cannot safely protect a path containing pattern characters");
    }
    return projects;
}

export async function linuxDotEnvMask(roots: readonly string[], store: MaskedFileStore): Promise<Pick<LinuxSandboxParams, "maskedFileBinds" | "maskedFileStoreDir">> {
    const maskedFileBinds: NonNullable<LinuxSandboxParams["maskedFileBinds"]> = [];
    for (const root of await protectedRoots(roots)) {
        const path = join(root, ".env");
        const info = await lstat(path).catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
            throw error;
        });
        // Existing files (including symlinks) retain their real content and configured
        // read denials. The manager owns the source file and disposes it on reset.
        if (!info) maskedFileBinds.push({realPath: path, fakePath: store.write("hicode:absent-dotenv", "")});
    }
    return {maskedFileBinds, maskedFileStoreDir: store.dirPath};
}

/** Mount masks protect concrete paths. Never approximate a user-supplied glob denial. */
export async function linuxFilesystemPolicy(config: SandboxRuntimeConfig, signal: AbortSignal, roots: readonly string[]): Promise<SandboxRuntimeConfig> {
    for (const path of [...config.filesystem.denyRead, ...config.filesystem.denyWrite]) {
        if (/[*?\[\]{}()!\\]/.test(path)) {
            throw new Error("Linux Sandbox requires literal denyRead/denyWrite paths; glob denials cannot be enforced by mount masks");
        }
    }
    const canonicalRoots = await protectedRoots(roots);
    const denied = new Set(config.filesystem.denyWrite);
    for (const root of canonicalRoots) {
        for (const name of [".git", ".hicode", ".env"]) denied.add(join(root, name));
    }
    const pending = [...canonicalRoots];
    const seen = new Set<string>();
    const deadline = Date.now() + 5000;
    let entries = 0;
    const checkBudget = () => {
        signal.throwIfAborted();
        if (Date.now() > deadline || entries > 200_000) {
            throw new Error("Linux Sandbox protected-path discovery exceeded its limits; narrow the workspace");
        }
    };
    while (pending.length) {
        checkBudget();
        const directory = pending.pop();
        if (!directory) break;
        if (seen.has(directory)) continue;
        seen.add(directory);
        // Explicitly denied subtrees need no inspection and may be unreadable.
        if (config.filesystem.denyWrite.some(path => isPathInside(path, directory))) continue;
        for await (const entry of await opendir(directory)) {
            entries++;
            checkBudget();
            const path = join(directory, entry.name);
            if (entry.name === ".git" || entry.name === ".hicode" || entry.name.startsWith(".env")) {
                // The manager also filters globs in generated rules. Literal names
                // containing pattern characters must not silently lose protection.
                if (/[*?\[\]{}()!\\]/.test(path)) throw new Error(`Linux Sandbox cannot safely protect a path containing pattern characters: ${path}`);
                denied.add(path);
                continue;
            }
            if (entry.isDirectory()) pending.push(path);
            else if (entry.isSymbolicLink()) {
                // Follow aliases only within granted project trees, once per target.
                const target = await realpath(path).catch((error: unknown) => {
                    if (error instanceof Error && "code" in error && ["ENOENT", "ELOOP"].includes(String(error.code))) return undefined;
                    throw error;
                });
                if (target && canonicalRoots.some(root => isPathInside(root, target))) {
                    if ((await stat(target)).isDirectory()) pending.push(target);
                }
            }
        }
    }
    return {...config, filesystem: {...config.filesystem, denyWrite: [...denied]}};
}
