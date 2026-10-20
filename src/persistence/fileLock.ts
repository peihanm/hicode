import {randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {dirname, join} from "node:path";
import {lstat, mkdir, open, readdir, rmdir, unlink} from "node:fs/promises";
import {captureProcessIdentity, processOwnerState} from "./processIdentity.js";

const TIMEOUT_MS = 2_000;
const RETRY_MS = 20;
const STALE_MS = 30_000;
const OWNER = /^v1-([1-9][0-9]*)-([a-f0-9]{64})-([a-f0-9]{64})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;

function isCode(error: unknown, code: string): boolean {
    return !!error && typeof error === "object" && "code" in error && error.code === code;
}

async function removeEmptyDirectory(path: string): Promise<void> {
    try { await rmdir(path); }
    catch (error) {
        if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY") && !isCode(error, "EEXIST")) throw error;
    }
}

async function inspectDirectory(path: string) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe persistence lock (expected a directory): ${path}`);
    const entries = await readdir(path, {withFileTypes: true});
    if (entries.length > 128 || entries.some(entry => !entry.isFile() || !OWNER.test(entry.name))) {
        throw new Error(`Invalid persistence lock owner: ${path}`);
    }
    return {info, entries};
}

/** Remove only a dead owner's unique marker, then rmdir only if no other owner exists. */
async function recoverAbandonedDirectory(path: string, local: Awaited<ReturnType<typeof captureProcessIdentity>>): Promise<void> {
    try {
        const {info, entries} = await inspectDirectory(path);
        if (entries.length === 0 && Date.now() - info.mtimeMs < STALE_MS) return;
        for (const entry of entries) {
            const match = OWNER.exec(entry.name)!;
            const pid = Number(match[1]);
            if (!Number.isSafeInteger(pid) || pid > 2_147_483_647) throw new Error("Invalid persistence owner PID");
            const state = await processOwnerState({pid, environment: match[2]!, start: match[3]!}, local);
            if (state === "unknown") throw new Error(`Cannot verify persistence lock owner in this environment: ${path}`);
            // The live holder may release and a new holder may mkdir while we
            // probe its PID. Do not rmdir a potentially new, unpublished lease.
            if (state === "alive") return;
            try { await unlink(join(path, entry.name)); }
            catch (error) { if (isCode(error, "ENOENT")) return; throw error; }
        }
        // A competing initializer that has published a marker prevents rmdir.
        await removeEmptyDirectory(path);
    } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
}

/** Directory leases need no recovery guard that can itself be orphaned. */
export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    return lockWithIdentity(path, action, await captureProcessIdentity());
}

/** A long-lived writer owns this immutable process snapshot; competing owners are always probed live. */
export function createFileLocker() {
    let identity: ReturnType<typeof captureProcessIdentity> | undefined;
    return async <T>(path: string, action: () => Promise<T>): Promise<T> => {
        const local = await (identity ??= captureProcessIdentity());
        return lockWithIdentity(path, action, local);
    };
}

async function lockWithIdentity<T>(path: string, action: () => Promise<T>, local: Awaited<ReturnType<typeof captureProcessIdentity>>): Promise<T> {
    // Publish identity in the filename so another process never reads a partial owner record.
    const owner = `v1-${local.pid}-${local.environment}-${local.start}-${randomUUID()}`;
    const marker = join(path, owner);
    const deadline = Date.now() + TIMEOUT_MS;
    await mkdir(dirname(path), {recursive: true});
    while (true) {
        let created = false;
        try { await mkdir(path, {mode: 0o700}); created = true; }
        catch (error) { if (!isCode(error, "EEXIST")) throw error; }
        if (created) {
            let published = false;
            try {
                let acquired = false;
                try {
                    const handle = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                    published = true;
                    await handle.close();
                    const {entries} = await inspectDirectory(path);
                    // An initializer paused while its empty directory was reaped must not
                    // enter alongside the initializer of a replacement directory.
                    acquired = entries.length === 1 && entries[0]!.name === owner;
                } catch (error) {
                    // Retry only acquisition races, including a vanished published marker.
                    // macOS may report EINVAL during exclusive marker creation.
                    if (!isCode(error, "ENOENT") && !(process.platform === "darwin" && !published && isCode(error, "EINVAL"))) throw error;
                }
                // Once entered, an action may have side effects; never replay its errors.
                if (acquired) return await action();
            } finally {
                if (published) {
                    try { await unlink(marker); }
                    catch (error) { if (!isCode(error, "ENOENT")) throw error; }
                }
                await removeEmptyDirectory(path);
            }
        } else {
            await recoverAbandonedDirectory(path, local);
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for persistence lock: ${path}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    }
}
