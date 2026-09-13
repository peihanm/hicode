import {randomUUID} from "node:crypto";
import {constants} from "node:fs";
import {dirname, join} from "node:path";
import {lstat, mkdir, open, readdir, rmdir, unlink} from "node:fs/promises";

const TIMEOUT_MS = 2_000;
const RETRY_MS = 20;
const STALE_MS = 30_000;
const OWNER = /^([1-9][0-9]*)-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;

function isCode(error: unknown, code: string): boolean {
    return !!error && typeof error === "object" && "code" in error && error.code === code;
}

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return !isCode(error, "ESRCH"); }
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
async function recoverAbandonedDirectory(path: string): Promise<void> {
    try {
        const {info, entries} = await inspectDirectory(path);
        if (entries.length === 0 && Date.now() - info.mtimeMs < STALE_MS) return;
        for (const entry of entries) {
            const pid = Number(OWNER.exec(entry.name)![1]);
            if (!Number.isSafeInteger(pid) || alive(pid)) continue;
            try { await unlink(join(path, entry.name)); }
            catch (error) { if (!isCode(error, "ENOENT")) throw error; }
        }
        // A competing initializer that has published a marker prevents rmdir.
        await removeEmptyDirectory(path);
    } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
}

/** Directory leases need no recovery guard that can itself be orphaned. */
export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const owner = `${process.pid}-${randomUUID()}`;
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
                const handle = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                published = true;
                await handle.close();
                const {entries} = await inspectDirectory(path);
                // An initializer paused while its empty directory was reaped must not
                // enter alongside the initializer of a replacement directory.
                if (entries.length === 1 && entries[0]!.name === owner) return await action();
            } catch (error) {
                if (!isCode(error, "ENOENT") || published) throw error;
            } finally {
                if (published) {
                    try { await unlink(marker); }
                    catch (error) { if (!isCode(error, "ENOENT")) throw error; }
                }
                await removeEmptyDirectory(path);
            }
        } else {
            await recoverAbandonedDirectory(path);
        }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for persistence lock: ${path}`);
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    }
}
