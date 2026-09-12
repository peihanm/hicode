import {randomUUID} from "node:crypto";
import {closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync} from "node:fs";
import {mkdir, open, unlink} from "node:fs/promises";
import {dirname, join, relative, resolve} from "node:path";
import {throwIfTurnAborted} from "../../runtime/abort.js";

function missing(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function canonicalPath(path: string): string {
    let parent = dirname(path);
    while (true) {
        try { return resolve(realpathSync(parent), relative(parent, path)); }
        catch (error) {
            if (!missing(error) || dirname(parent) === parent) throw error;
            parent = dirname(parent);
        }
    }
}

interface FileVersion {
    content: Buffer | null;
    identity: string;
    mode?: number;
}

function readVersion(path: string): FileVersion {
    try {
        const entry = lstatSync(path);
        if (!entry.isFile()) throw new Error(`File commits require regular files; symlinks are not allowed: ${path}`);
    } catch (error) {
        if (missing(error)) return {content: null, identity: "missing"};
        throw error;
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = fstatSync(fd, {bigint: true});
        if (!before.isFile()) throw new Error(`File commit target is not a regular file: ${path}`);
        const content = readFileSync(fd);
        const after = fstatSync(fd, {bigint: true});
        const identity = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
        if (identity(before) !== identity(after)) throw new Error(`File changed while reading; use read_file again: ${path}`);
        return {content, identity: identity(after), mode: Number(after.mode) & 0o7777};
    } finally { closeSync(fd); }
}

function assertContent(version: FileVersion, expected: string | Buffer | null, path: string): void {
    if (expected === null ? version.content !== null : !version.content?.equals(Buffer.from(expected))) {
        throw new Error(`File changed before commit; external content was preserved. Use read_file again: ${path}`);
    }
}

/** Root owns ordering, while each Session owns its separate observation ledger. */
export class FileCommitCoordinator {
    private active: Promise<void> | undefined;

    async run<T>(path: string, signal: AbortSignal, operation: (canonical: string) => Promise<T>): Promise<T> {
        const canonical = canonicalPath(resolve(path));
        return this.exclusive(signal, () => operation(canonical));
    }

    /** Root-owned foreground Shell and file commits share a write ordering boundary. */
    async exclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
        while (this.active) {
            const pending = this.active;
            throwIfTurnAborted(signal);
            await new Promise<void>((done, reject) => {
                const aborted = () => {
                    signal.removeEventListener("abort", aborted);
                    try {throwIfTurnAborted(signal);} catch (error) {reject(error);}
                };
                signal.addEventListener("abort", aborted, {once: true});
                void pending.then(() => {signal.removeEventListener("abort", aborted); done();});
            });
        }
        throwIfTurnAborted(signal);
        let release!: () => void;
        this.active = new Promise<void>(done => {release = done;});
        try {return await operation();} finally {this.active = undefined; release();}
    }

}

export function prepareFileCommit(path: string, canonical: string, expected: string | Buffer | null, targetMode?: number) {
    if (canonicalPath(path) !== canonical) throw new Error(`File path changed while waiting: ${path}`);
    const version = readVersion(path);
    assertContent(version, expected, path);
    return async (content: string | Buffer | null, signal: AbortSignal): Promise<string | undefined> => {
        let temporary: string | undefined;
        try {
            throwIfTurnAborted(signal);
            if (canonicalPath(path) !== canonical) throw new Error(`File path changed before commit: ${path}`);
            if (content !== null) {
                // Stage on the same filesystem; final rename cannot expose a partial file.
                await mkdir(dirname(canonical), {recursive: true});
                temporary = join(dirname(canonical), `.pillar-write-${randomUUID()}.tmp`);
                const file = await open(temporary, "wx", targetMode ?? version.mode ?? 0o666);
                try {
                    await file.writeFile(content, "utf8");
                    if (targetMode !== undefined || version.mode !== undefined) await file.chmod(targetMode ?? version.mode!);
                    await file.sync();
                } finally { await file.close(); }
            }
            // No await from the final path/version/signal check through the commit.
            if (canonicalPath(path) !== canonical) throw new Error(`File path changed before commit: ${path}`);
            const current = readVersion(path);
            assertContent(current, expected, path);
            if (current.identity !== version.identity) throw new Error(`File identity changed before commit; use read_file again: ${path}`);
            throwIfTurnAborted(signal);
            if (content === null) unlinkSync(canonical);
            else if (expected === null) {
                // Unlike rename, link cannot replace a file created by an external writer.
                linkSync(temporary!, canonical);
                // Unlink changes ctime on the shared inode; capture the receipt afterwards.
                try { unlinkSync(temporary!); temporary = undefined; }
                catch { return undefined; } // Committed, but final cleanup may change its identity.
            } else renameSync(temporary!, canonical);
            if (content !== null) {
                try {
                    const info = lstatSync(canonical, {bigint: true});
                    return [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");
                } catch { /* The write committed; a missing receipt only requires a new read. */ }
            }
            return undefined;
        } finally {
            if (temporary) await unlink(temporary).catch(() => undefined);
        }
    };
}
