import {mkdir, readFile, stat} from "node:fs/promises";
import {join} from "node:path";
import {
    hasFileSystemErrorCode,
    hashProjectValue,
    withFileLock,
    writeFileAtomically,
} from "../persistence/index.js";
import type {AgentWorktreeRecord} from "./types.js";

const MAX_MANIFEST_BYTES = 64 * 1024;

function manifestKey(taskId: string): string {
    return `task-${hashProjectValue(taskId, 32)}`;
}

function isRecord(
    value: unknown,
    taskId: string,
    sessionId: string
): value is AgentWorktreeRecord {
    if (!value || typeof value !== "object") return false;
    const record = value as Partial<AgentWorktreeRecord>;
    const allowedKeys = new Set([
        "version", "taskId", "sessionId", "sourceCwd", "sourceGitRoot",
        "mainGitRoot", "path", "branch", "baseCommit", "sourceHadChanges",
        "createdAt", "state", "cleanupReason", "issue",
    ]);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false;
    const validString = (candidate: unknown, max: number) =>
        typeof candidate === "string" && candidate.length > 0 && candidate.length <= max;
    return record.version === 2 &&
        record.taskId === taskId &&
        record.sessionId === sessionId &&
        validString(record.sourceCwd, 4_096) &&
        validString(record.sourceGitRoot, 4_096) &&
        validString(record.mainGitRoot, 4_096) &&
        validString(record.path, 4_096) &&
        validString(record.branch, 256) &&
        typeof record.baseCommit === "string" &&
        /^[0-9a-f]{40,64}$/i.test(record.baseCommit) &&
        typeof record.sourceHadChanges === "boolean" &&
        typeof record.createdAt === "string" &&
        Number.isFinite(Date.parse(record.createdAt)) &&
        (
            record.state === "active" ||
            record.state === "changed" ||
            record.state === "cleaned"
        ) &&
        (
            record.cleanupReason === undefined ||
            record.cleanupReason === "no_changes" ||
            record.cleanupReason === "explicit_discard"
        ) &&
        (
            (record.state === "cleaned" && record.cleanupReason !== undefined) ||
            (record.state !== "cleaned" && record.cleanupReason === undefined)
        ) &&
        (
            record.issue === undefined ||
            (typeof record.issue === "string" && record.issue.length <= 8_000)
        );
}

export class WorktreeManifestStore {
    constructor(private readonly directory: string) {}

    async create(record: AgentWorktreeRecord): Promise<void> {
        await this.withRecordLock(record.taskId, async () => {
            const existing = await this.readUnlocked(record.taskId, record.sessionId);
            if (existing) {
                throw new Error(`Worktree manifest 已存在: ${record.taskId}`);
            }
            await this.writeUnlocked(record);
        });
    }

    load(
        taskId: string,
        sessionId: string
    ): Promise<AgentWorktreeRecord | undefined> {
        return this.withRecordLock(taskId, () =>
            this.readUnlocked(taskId, sessionId)
        );
    }

    update(
        taskId: string,
        sessionId: string,
        action: (
            current: AgentWorktreeRecord
        ) => Promise<AgentWorktreeRecord>
    ): Promise<AgentWorktreeRecord> {
        return this.withRecordLock(taskId, async () => {
            const current = await this.readUnlocked(taskId, sessionId);
            if (!current) throw new Error(`Worktree manifest 不存在: ${taskId}`);
            const updated = await action(current);
            if (
                updated.taskId !== taskId ||
                updated.sessionId !== sessionId ||
                updated.version !== 2
            ) {
                throw new Error("Worktree manifest 更新改变了身份字段");
            }
            await this.writeUnlocked(updated);
            return updated;
        });
    }

    private manifestPath(taskId: string): string {
        return join(this.directory, `${manifestKey(taskId)}.json`);
    }

    private lockPath(taskId: string): string {
        return join(this.directory, `${manifestKey(taskId)}.lock`);
    }

    private withRecordLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
        return withFileLock(this.lockPath(taskId), action);
    }

    private async readUnlocked(
        taskId: string,
        sessionId: string
    ): Promise<AgentWorktreeRecord | undefined> {
        const path = this.manifestPath(taskId);
        let size: number;
        try {
            size = (await stat(path)).size;
        } catch (error) {
            if (hasFileSystemErrorCode(error, "ENOENT")) return undefined;
            throw error;
        }
        if (size > MAX_MANIFEST_BYTES) {
            throw new Error(`Worktree manifest 超过 ${MAX_MANIFEST_BYTES} 字节限制`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
            throw new Error(
                `无法读取 Worktree manifest: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
        if (!isRecord(parsed, taskId, sessionId)) {
            throw new Error("Worktree manifest 格式无效或不属于当前 Session");
        }
        return parsed;
    }

    private async writeUnlocked(record: AgentWorktreeRecord): Promise<void> {
        const content = `${JSON.stringify(record, null, 2)}\n`;
        if (Buffer.byteLength(content) > MAX_MANIFEST_BYTES) {
            throw new Error(`Worktree manifest 超过 ${MAX_MANIFEST_BYTES} 字节限制`);
        }
        await mkdir(this.directory, {recursive: true, mode: 0o700});
        await writeFileAtomically(this.manifestPath(record.taskId), content, 0o600);
    }
}
