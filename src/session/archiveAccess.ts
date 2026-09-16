import {basename, dirname, relative, resolve} from "node:path";
import {realpath} from "node:fs/promises";
import {getSessionArchiveDirectory, type HiCodeStorageLayout} from "../persistence/layout.js";

export interface SessionArchiveAccess {
    resolve(path: string): Promise<{path: string; byteLength: number; complete: boolean} | null>;
}

export function isSessionArchivePath(storage: HiCodeStorageLayout, path: string): boolean {
    const rel = relative(storage.projectsRoot, resolve(path));
    return !rel.startsWith("..") && /(?:^|\/)sessions\/session-[^/]+\/archives(?:\/|$)/.test(rel);
}

export async function checkSessionArchivePath(storage: HiCodeStorageLayout, path: string): Promise<boolean> {
    if (isSessionArchivePath(storage, path)) return true;
    let probe = resolve(path);
    const missing: string[] = [];
    for (;;) {
        try {
            const canonical = resolve(await realpath(probe), ...missing);
            if (!/\/sessions\/session-[^/]+\/archives(?:\/|$)/.test(canonical)) return false;
            const root = await realpath(storage.projectsRoot);
            const rel = relative(root, canonical);
            if (!rel.startsWith("..") && !rel.startsWith("/") && /(?:^|\/)sessions\/session-[^/]+\/archives(?:\/|$)/.test(rel)) {
                throw new Error("Compaction archives cannot be accessed through path aliases; use the original framework-provided path");
            }
            return false;
        } catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
            const parent = dirname(probe);
            if (parent === probe || missing.length >= 256) throw new Error("Cannot validate archive path");
            missing.unshift(basename(probe));
            probe = parent;
        }
    }
}

export async function resolveSessionArchiveFile(storage: HiCodeStorageLayout, access: SessionArchiveAccess | undefined, path: string) {
    if (!isSessionArchivePath(storage, path)) return null;
    if (!access) throw new Error("This Agent has no Session compaction archive read capability");
    const file = await access.resolve(path);
    if (!file) throw new Error("Cannot validate compaction archive");
    return file;
}

export function archiveIndexPath(storage: HiCodeStorageLayout, cwd: string, sessionId: string, id: string): string {
    return resolve(getSessionArchiveDirectory(storage, cwd, sessionId), `${id}-index.txt`);
}
