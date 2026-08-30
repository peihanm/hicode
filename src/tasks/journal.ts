import {existsSync} from "node:fs";
import {appendFile, chmod, lstat, mkdir, readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {
    getSessionStorageDirectory,
    type PillarStorageLayout,
    withFileLock,
    writeFileAtomically,
} from "../persistence/index.js";
import {
    decodeTaskJournalEntry,
    serializeTaskJournalEntry,
    type TaskJournalEntry,
} from "./codec.js";
import type {TaskEventEnvelope, TaskSnapshot} from "./types.js";

const MAX_TASK_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_TASK_JOURNAL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TASK_JOURNAL_ENTRIES = 4_096;
const MAX_PERSISTED_TASKS = 32;
const COMPACT_TASK_JOURNAL_ENTRIES = 1_024;

export interface LoadedTaskJournal {
    sequence: number;
    tasks: readonly TaskSnapshot[];
    claimedTaskIds: ReadonlySet<string>;
}

export interface TaskJournalLike {
    append(event: TaskEventEnvelope): Promise<void>;
    markNotificationClaimed(input: {
        sequence: number;
        sessionId: string;
        taskId: string;
    }): Promise<void>;
    load(sessionId: string): Promise<LoadedTaskJournal>;
}

function journalPath(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string
): string {
    return join(
        getSessionStorageDirectory(storage, cwd, sessionId),
        "tasks",
        "events.jsonl"
    );
}

function isErrorCode(error: unknown, code: string): boolean {
    return Boolean(
        error && typeof error === "object" && "code" in error &&
        (error as {code?: string}).code === code
    );
}

interface ParsedJournal {
    entries: TaskJournalEntry[];
    requiresRewrite: boolean;
}

interface CachedJournal extends ParsedJournal {
    size: number;
    mtimeMs: number;
    ino: number;
}

async function readJournal(
    path: string,
    sessionId: string
): Promise<ParsedJournal> {
    let info;
    try {
        info = await lstat(path);
    } catch (error) {
        if (isErrorCode(error, "ENOENT")) {
            return {entries: [], requiresRewrite: false};
        }
        throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Task Journal 不是安全的 regular file: ${path}`);
    }
    if (info.size > MAX_TASK_JOURNAL_BYTES) {
        throw new Error(`Task Journal 超过大小上限: ${path}`);
    }
    const content = await readFile(path, "utf8");
    const lines = content.split("\n");
    const hasTrailingNewline = content.endsWith("\n");
    const entries: TaskJournalEntry[] = [];
    let nonEmptyLines = 0;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!line.trim()) continue;
        nonEmptyLines += 1;
        if (
            nonEmptyLines > MAX_TASK_JOURNAL_ENTRIES ||
            Buffer.byteLength(line, "utf8") > MAX_TASK_JOURNAL_LINE_BYTES
        ) throw new Error(`Task Journal 超过条目或单行上限: ${path}`);
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (error) {
            const partialTail = index === lines.length - 1 && !hasTrailingNewline;
            if (partialTail) {
                return {entries, requiresRewrite: true};
            }
            throw new Error(`Task Journal 包含损坏记录: ${path}`, {cause: error});
        }
        const entry = decodeTaskJournalEntry(parsed, sessionId);
        if (!entry) throw new Error(`Task Journal 包含非法记录: ${path}`);
        entries.push(entry);
    }
    return {
        entries,
        requiresRewrite: content.length > 0 && !hasTrailingNewline,
    };
}

function compactEntries(entries: readonly TaskJournalEntry[]): TaskJournalEntry[] {
    const latestTasks = new Map<string, TaskEventEnvelope>();
    const claims = new Map<string, TaskJournalEntry>();
    for (const entry of entries) {
        if (entry.type === "task_notification_claimed") {
            claims.set(entry.taskId, entry);
        } else {
            latestTasks.set(entry.task.id, entry);
        }
    }
    const retainedTasks = [...latestTasks.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-MAX_PERSISTED_TASKS);
    const retainedIds = new Set(retainedTasks.map((entry) => entry.task.id));
    return [
        ...retainedTasks,
        ...[...claims.values()].filter((entry) =>
            entry.type === "task_notification_claimed" && retainedIds.has(entry.taskId)
        ),
    ].sort((left, right) => left.sequence - right.sequence);
}

function renderEntries(entries: readonly TaskJournalEntry[]): string {
    return `${entries.map(serializeTaskJournalEntry).join("\n")}\n`;
}

function loadedJournal(entries: readonly TaskJournalEntry[]): LoadedTaskJournal {
    const tasks = new Map<string, TaskSnapshot>();
    const claimedTaskIds = new Set<string>();
    let sequence = 0;
    for (const entry of entries) {
        sequence = Math.max(sequence, entry.sequence);
        if (entry.type === "task_notification_claimed") {
            claimedTaskIds.add(entry.taskId);
        } else {
            tasks.set(entry.task.id, entry.task);
        }
    }
    return {sequence, tasks: [...tasks.values()], claimedTaskIds};
}

class TaskJournal implements TaskJournalLike {
    private appendTail: Promise<void> = Promise.resolve();
    private readonly cache = new Map<string, CachedJournal>();

    constructor(
        private readonly storage: PillarStorageLayout,
        private readonly cwd: string,
    ) {}

    async append(event: TaskEventEnvelope): Promise<void> {
        await this.appendEntry(event);
    }

    async markNotificationClaimed(input: {
        sequence: number;
        sessionId: string;
        taskId: string;
    }): Promise<void> {
        await this.appendEntry({
            version: 2,
            type: "task_notification_claimed",
            ...input,
        });
    }

    async load(sessionId: string): Promise<LoadedTaskJournal> {
        const path = journalPath(this.storage, this.cwd, sessionId);
        await mkdir(dirname(path), {recursive: true, mode: 0o700});
        return withFileLock(`${path}.lock`, async () => {
            const current = await this.readCurrent(path, sessionId);
            return loadedJournal(current.entries);
        });
    }

    private async readCurrent(
        path: string,
        sessionId: string
    ): Promise<ParsedJournal> {
        const cached = this.cache.get(path);
        try {
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink()) {
                throw new Error(`Task Journal 不是安全的 regular file: ${path}`);
            }
            if (
                cached &&
                cached.size === info.size &&
                cached.mtimeMs === info.mtimeMs &&
                cached.ino === info.ino
            ) return cached;
        } catch (error) {
            if (!isErrorCode(error, "ENOENT")) throw error;
            if (cached?.size === 0) return cached;
        }
        const parsed = await readJournal(path, sessionId);
        await this.remember(path, parsed);
        return parsed;
    }

    private async remember(path: string, parsed: ParsedJournal): Promise<void> {
        try {
            const info = await lstat(path);
            this.cache.set(path, {
                ...parsed,
                size: info.size,
                mtimeMs: info.mtimeMs,
                ino: info.ino,
            });
        } catch (error) {
            if (!isErrorCode(error, "ENOENT")) throw error;
            this.cache.set(path, {...parsed, size: 0, mtimeMs: 0, ino: 0});
        }
    }

    private async appendEntry(entry: TaskJournalEntry): Promise<void> {
        const append = this.appendTail
            .catch(() => undefined)
            .then(async () => {
                const path = journalPath(this.storage, this.cwd, entry.sessionId);
                const line = `${serializeTaskJournalEntry(entry)}\n`;
                if (Buffer.byteLength(line, "utf8") > MAX_TASK_JOURNAL_LINE_BYTES) {
                    throw new Error(`Task Journal 单行超过大小上限: ${path}`);
                }
                await withFileLock(`${path}.lock`, async () => {
                    await mkdir(dirname(path), {recursive: true, mode: 0o700});
                    await chmod(dirname(path), 0o700);
                    const current = await this.readCurrent(path, entry.sessionId);
                    const shouldCompact = current.requiresRewrite ||
                        current.entries.length + 1 >= COMPACT_TASK_JOURNAL_ENTRIES;
                    if (shouldCompact) {
                        const content = renderEntries(compactEntries([
                            ...current.entries,
                            entry,
                        ]));
                        if (Buffer.byteLength(content, "utf8") > MAX_TASK_JOURNAL_BYTES) {
                            throw new Error(`Task Journal 压缩后仍超过大小上限: ${path}`);
                        }
                        await writeFileAtomically(path, content, 0o600);
                        await this.remember(path, {
                            entries: compactEntries([...current.entries, entry]),
                            requiresRewrite: false,
                        });
                        return;
                    }
                    const currentBytes = existsSync(path) ? (await lstat(path)).size : 0;
                    if (currentBytes + Buffer.byteLength(line, "utf8") > MAX_TASK_JOURNAL_BYTES) {
                        const content = renderEntries(compactEntries([
                            ...current.entries,
                            entry,
                        ]));
                        if (Buffer.byteLength(content, "utf8") > MAX_TASK_JOURNAL_BYTES) {
                            throw new Error(`Task Journal 压缩后仍超过大小上限: ${path}`);
                        }
                        await writeFileAtomically(path, content, 0o600);
                        await this.remember(path, {
                            entries: compactEntries([...current.entries, entry]),
                            requiresRewrite: false,
                        });
                        return;
                    }
                    await appendFile(path, line, {encoding: "utf8", mode: 0o600});
                    await this.remember(path, {
                        entries: [...current.entries, entry],
                        requiresRewrite: false,
                    });
                });
            });
        this.appendTail = append;
        await append;
    }
}

export function createTaskJournal(
    storage: PillarStorageLayout,
    cwd: string
): TaskJournalLike {
    return new TaskJournal(storage, cwd);
}
