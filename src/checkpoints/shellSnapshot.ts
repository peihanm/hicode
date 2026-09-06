import {constants} from "node:fs";
import {lstat, open, opendir, realpath} from "node:fs/promises";
import {isAbsolute, join, relative} from "node:path";
import {fingerprintContent, MAX_CHECKPOINT_FILE_BYTES} from "./fingerprint.js";
import type {FileFingerprint} from "./types.js";

interface SnapshotFile {content: Buffer; fingerprint: FileFingerprint}
export interface ShellSnapshot {
    root: string;
    deniedWritePaths: string[];
    files: Map<string, SnapshotFile>;
}

function within(root: string, path: string): boolean {
    const part = relative(root, path);
    return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"));
}

/** Dependencies are outside source rollback; credentials and metadata also remain write-protected. */
export async function snapshotShellWorkspace(root: string, pillarHome: string, deniedReadPaths: readonly string[]): Promise<ShellSnapshot> {
    root = await realpath(root);
    pillarHome = await realpath(pillarHome);
    const files = new Map<string, SnapshotFile>();
    const excluded = new Set([join(root, ".git"), join(root, ".pillar"), join(root, ".env")]);
    if (within(root, pillarHome)) excluded.add(pillarHome);
    for (const denied of deniedReadPaths) {
        if (!isAbsolute(denied) || /[*?{}[\]]/.test(denied)) throw new Error("Shell 快照不能安全解释动态 denyRead 路径");
        const canonical = await realpath(denied).catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return denied;
            throw error;
        });
        if (within(canonical, root)) throw new Error("Shell 快照目录被 denyRead 覆盖");
        if (within(root, canonical)) excluded.add(canonical);
    }
    const started = Date.now();
    let entries = 0;
    let bytes = 0;
    let pathBytes = 0;
    const visit = async (directory: string): Promise<void> => {
        if (await realpath(directory) !== directory) throw new Error("Shell 快照目录发生重定向");
        for await (const entry of await opendir(directory)) {
            if (++entries > 10_000 || Date.now() - started > 2_500) throw new Error("Shell 快照超过 10k 条目或 2.5s 扫描预算");
            const path = join(directory, entry.name);
            if (entry.name === "node_modules") continue;
            if (excluded.has(path) || [".git", ".pillar"].includes(entry.name) || entry.name.startsWith(".env")) {
                excluded.add(path);
                continue;
            }
            const info = await lstat(path);
            if (info.isDirectory()) {await visit(path); continue;}
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Shell 快照不支持链接或特殊文件: ${path}`);
            bytes += info.size;
            pathBytes += Buffer.byteLength(relative(root, path));
            if (pathBytes > 256 * 1024) throw new Error("Shell 快照超过 256 KiB 路径元数据预算");
            if (files.size >= 2_000 || info.size > MAX_CHECKPOINT_FILE_BYTES || bytes > 32 * 1024 * 1024) {
                throw new Error("Shell 快照超过 2000 文件 / 32 MiB 总量 / 20 MiB 单文件预算");
            }
            if (await realpath(path) !== path) throw new Error(`Shell 快照路径改变: ${path}`);
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                const before = await handle.stat();
                if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) throw new Error("Shell 快照文件已改变");
                const content = Buffer.alloc(info.size);
                let offset = 0;
                while (offset < content.length) {
                    const {bytesRead} = await handle.read(content, offset, content.length - offset, offset);
                    if (!bytesRead) throw new Error("Shell 快照文件读取不完整");
                    offset += bytesRead;
                }
                const after = await handle.stat();
                if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || await realpath(path) !== path) throw new Error("Shell 快照读取期间文件已改变");
                files.set(path, {content, fingerprint: fingerprintContent(content, before.mode)});
            } finally {await handle.close();}
        }
    };
    await visit(root);
    return {root, files, deniedWritePaths: [...excluded].sort()};
}
