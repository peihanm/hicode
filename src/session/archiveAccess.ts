import {basename, dirname, relative, resolve} from "node:path";
import {realpath} from "node:fs/promises";
import {getSessionArchiveDirectory, type PillarStorageLayout} from "../persistence/layout.js";

export interface SessionArchiveAccess {
    resolve(path: string): Promise<{path: string; byteLength: number; complete: boolean} | null>;
}

export function isSessionArchivePath(storage: PillarStorageLayout, path: string): boolean {
    const rel = relative(storage.projectsRoot, resolve(path));
    return !rel.startsWith("..") && /(?:^|\/)sessions\/session-[^/]+\/archives(?:\/|$)/.test(rel);
}

export async function checkSessionArchivePath(storage: PillarStorageLayout, path: string): Promise<boolean> {
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
                throw new Error("压缩档案禁止通过路径别名访问，请使用框架提供的原始路径");
            }
            return false;
        } catch (error) {
            if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
            const parent = dirname(probe);
            if (parent === probe || missing.length >= 256) throw new Error("无法验证档案路径");
            missing.unshift(basename(probe));
            probe = parent;
        }
    }
}

export async function resolveSessionArchiveFile(storage: PillarStorageLayout, access: SessionArchiveAccess | undefined, path: string) {
    if (!isSessionArchivePath(storage, path)) return null;
    if (!access) throw new Error("当前 Agent 未获授 Session 压缩档案读取能力");
    const file = await access.resolve(path);
    if (!file) throw new Error("无法验证压缩档案");
    return file;
}

export function archiveIndexPath(storage: PillarStorageLayout, cwd: string, sessionId: string, id: string): string {
    return resolve(getSessionArchiveDirectory(storage, cwd, sessionId), `${id}-index.txt`);
}
