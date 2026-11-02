import {randomUUID} from "node:crypto";
import {closeSync, constants, fstatSync, linkSync, openSync, readSync, realpathSync, renameSync, unlinkSync} from "node:fs";
import type {BigIntStats} from "node:fs";
import {mkdir, open, unlink} from "node:fs/promises";
import {dirname, join, relative, resolve} from "node:path";
import {throwIfTurnAborted} from "../../runtime/abort.js";
import {hasFileSystemErrorCode} from "../../persistence/errors.js";

const MAX_FILE_SNAPSHOT_BYTES = 20 * 1024 * 1024;

function identity(info: BigIntStats): string {
    return [info.dev, info.ino, info.size, info.mode, info.mtimeNs, info.ctimeNs].join(":");
}

function allocateSnapshot(info: BigIntStats): Buffer {
    if (!info.isFile()) throw new Error("Only regular files are supported, not directories, symlinks or special files");
    if (info.size > BigInt(MAX_FILE_SNAPSHOT_BYTES)) throw new Error(`File exceeds the ${MAX_FILE_SNAPSHOT_BYTES} byte safe-read limit`);
    return Buffer.alloc(Number(info.size));
}

/** Bounded bytes from one regular-file descriptor; verify identity before returning. */
export async function readFileSnapshot(path: string, signal: AbortSignal): Promise<{content: Buffer}> {
    signal.throwIfAborted();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        signal.throwIfAborted();
        const before = await handle.stat({bigint: true});
        const content = allocateSnapshot(before);
        let position = 0;
        while (position < content.length) {
            signal.throwIfAborted();
            const {bytesRead} = await handle.read(content, position, content.length - position, position);
            if (!bytesRead) break;
            position += bytesRead;
        }
        const after = await handle.stat({bigint: true});
        signal.throwIfAborted();
        if (position !== content.length || identity(before) !== identity(after)) throw new Error("File changed while reading; use read_file again");
        return {content};
    } finally { await handle.close(); }
}

function canonicalPath(path: string): string {
    let parent = dirname(path);
    while (true) {
        try { return resolve(realpathSync(parent), relative(parent, path)); }
        catch (error) {
            if (!hasFileSystemErrorCode(error, "ENOENT") || dirname(parent) === parent) throw error;
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
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if (hasFileSystemErrorCode(error, "ENOENT")) return {content: null, identity: "missing"};
        throw error;
    }
    try {
        const before = fstatSync(fd, {bigint: true});
        const content = allocateSnapshot(before);
        let position = 0;
        while (position < content.length) {
            const bytesRead = readSync(fd, content, position, content.length - position, position);
            if (!bytesRead) break;
            position += bytesRead;
        }
        const after = fstatSync(fd, {bigint: true});
        if (position !== content.length || identity(before) !== identity(after)) throw new Error(`File changed while reading; use read_file again: ${path}`);
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

    /** Serialize structured file commits within this Root. */
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
    return async (content: string | Buffer | null, signal: AbortSignal): Promise<void> => {
        let temporary: string | undefined;
        try {
            throwIfTurnAborted(signal);
            if (canonicalPath(path) !== canonical) throw new Error(`File path changed before commit: ${path}`);
            if (content !== null) {
                // Stage on the same filesystem; final rename cannot expose a partial file.
                await mkdir(dirname(canonical), {recursive: true});
                temporary = join(dirname(canonical), `.hicode-write-${randomUUID()}.tmp`);
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
                try { unlinkSync(temporary!); temporary = undefined; }
                catch { return; } // The finalizer retries cleanup; the file is already committed.
            } else renameSync(temporary!, canonical);

        } finally {
            if (temporary) await unlink(temporary).catch(() => undefined);
        }
    };
}

/** File tools share the Root commit boundary without persisting file history. */
export async function commitFileWrite(input: {
    coordinator: FileCommitCoordinator;
    signal: AbortSignal;
    path: string;
    beforeContent: string | Buffer | null;
    afterContent: string | Buffer | null;
}): Promise<void> {
    return input.coordinator.run(input.path, input.signal, async canonical => {
        const commit = prepareFileCommit(input.path, canonical, input.beforeContent);
        await commit(input.afterContent, input.signal);
    });
}
