import {lstat, opendir, realpath, stat} from "node:fs/promises";
import {join} from "node:path";
import type {SandboxRuntimeConfig} from "@anthropic-ai/sandbox-runtime";
import {isPathInside} from "../permissions/pathGuard.js";
import type {MaskedFileStore} from "@anthropic-ai/sandbox-runtime/dist/sandbox/credential-mask-files.js";
import type {LinuxSandboxParams} from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";

/** Preserve absent .env write protection without exposing a character device to dotenv readers. */
export async function linuxDotEnvMask(config: SandboxRuntimeConfig, store: MaskedFileStore): Promise<Pick<LinuxSandboxParams, "maskedFileBinds" | "maskedFileStoreDir">> {
    const root = config.filesystem.allowWrite[0];
    if (!root) throw new Error("Linux Sandbox requires a workspace root");
    const path = join(await realpath(root), ".env");
    const info = await lstat(path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
    });
    // Existing files (including symlinks) retain their real content and configured
    // read denials. The manager owns the source file and disposes it on reset.
    const maskedFileBinds = info ? [] : [{realPath: path, fakePath: store.write("hicode:absent-dotenv", "")}];
    return {maskedFileBinds, maskedFileStoreDir: store.dirPath};
}

/** Mount masks protect concrete paths. Never approximate a user-supplied glob denial. */
export async function linuxFilesystemPolicy(config: SandboxRuntimeConfig, signal: AbortSignal): Promise<SandboxRuntimeConfig> {
    for (const path of [...config.filesystem.denyRead, ...config.filesystem.denyWrite]) {
        if (/[*?\[\]{}()!\\]/.test(path)) {
            throw new Error("Linux Sandbox requires literal denyRead/denyWrite paths; glob denials cannot be enforced by mount masks");
        }
    }
    const root = config.filesystem.allowWrite[0];
    if (!root) throw new Error("Linux Sandbox requires a workspace root");
    const canonicalRoot = await realpath(root);
    const denied = new Set(config.filesystem.denyWrite);
    const pending = [canonicalRoot];
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
                // Traverse aliases back into the workspace once. Separate writable
                // grants retain their configured policy rather than extending this scan.
                const target = await realpath(path).catch((error: unknown) => {
                    if (error instanceof Error && "code" in error && ["ENOENT", "ELOOP"].includes(String(error.code))) return undefined;
                    throw error;
                });
                if (target && isPathInside(canonicalRoot, target)) {
                    if ((await stat(target)).isDirectory()) pending.push(target);
                }
            }
        }
    }
    return {...config, filesystem: {...config.filesystem, denyWrite: [...denied]}};
}
