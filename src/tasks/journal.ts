import {existsSync} from "node:fs";
import {appendFile, chmod, lstat, mkdir, readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {
    getSessionStorageDirectory,
    type HiCodeStorageLayout,
    withFileLock,
    writeFileAtomically,
} from "../persistence/index.js";
import {
    decodeTaskJournalEntry,
    serializeTaskJournalEntry,
    type TaskJournalEntry,
} from "./codec.js";
import {taskNotificationId} from "./notifications.js";
import type {TaskEventEnvelope, TaskSnapshot} from "./types.js";

const MAX_TASK_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_TASK_JOURNAL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_TASK_JOURNAL_ENTRIES = 4_096;
const MAX_PERSISTED_TASKS = 32;
const COMPACT_TASK_JOURNAL_ENTRIES = 1_024;

export interface LoadedTaskJournal {
    sequence: number;
    tasks: readonly TaskSnapshot[];
    pendingRuns: readonly TaskSnapshot[];
    claimedNotificationIds: ReadonlySet<string>;
}

export interface TaskJournalLike {
    append(event: TaskEventEnvelope): Promise<void>;
    markNotificationClaimed(input: {
        sequence: number;
        sessionId: string;
        taskId: string;
        notificationId: string;
    }): Promise<void>;
    load(sessionId: string): Promise<LoadedTaskJournal>;
}

function journalPath(
    storage: HiCodeStorageLayout,
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
        throw new Error(`Task Journal is not a safe regular file: ${path}`);
    }
    if (info.size > MAX_TASK_JOURNAL_BYTES) {
        throw new Error(`Task Journal exceeds the size limit: ${path}`);
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
        ) throw new Error(`Task Journal exceeds the entry or line limit: ${path}`);
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (error) {
            const partialTail = index === lines.length - 1 && !hasTrailingNewline;
            if (partialTail) {
                return {entries, requiresRewrite: true};
            }
            throw new Error(`Task Journal contains corrupt records: ${path}`, {cause: error});
        }
        const entry = decodeTaskJournalEntry(parsed, sessionId);
        if (!entry) throw new Error(`Task Journal contains invalid records: ${path}`);
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
    const terminals = new Map<string, TaskEventEnvelope>();
    for (const entry of entries) {
        if (entry.type === "task_notification_claimed") {
            claims.set(entry.notificationId, entry);
        } else {
            latestTasks.set(entry.task.id, entry);
            if (entry.task.status !== "running") terminals.set(taskNotificationId(entry.task.id, entry.task.kind === "agent" ? entry.task.progress.runCount : 1), entry);
        }
    }
    const retainedTasks = [...latestTasks.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-MAX_PERSISTED_TASKS);
    const pending = [...terminals].filter(([id]) => !claims.has(id)).map(([, entry]) => entry);
    const retained = new Map([...retainedTasks, ...pending].map(entry => [entry.sequence, entry]));
    const retainedNotificationIds = new Set(retainedTasks.map(entry => taskNotificationId(entry.task.id, entry.task.kind === "agent" ? entry.task.progress.runCount : 1)));
    const result = [
        ...retained.values(),
        ...[...claims].filter(([id]) => retainedNotificationIds.has(id)).map(([, entry]) => entry),
    ].sort((left, right) => left.sequence - right.sequence);
    if (result.length > MAX_TASK_JOURNAL_ENTRIES) throw new Error("Task Journal undelivered notifications exceed the entry limit");
    return result;
}

function renderEntries(entries: readonly TaskJournalEntry[]): string {
    return `${entries.map(serializeTaskJournalEntry).join("\n")}\n`;
}

function loadedJournal(entries: readonly TaskJournalEntry[]): LoadedTaskJournal {
    const tasks = new Map<string, TaskSnapshot>();
    const claimedNotificationIds = new Set<string>();
    const terminalRuns = new Map<string, TaskSnapshot>();
    let sequence = 0;
    for (const entry of entries) {
        sequence = Math.max(sequence, entry.sequence);
        if (entry.type === "task_notification_claimed") {
            claimedNotificationIds.add(entry.notificationId);
        } else {
            tasks.set(entry.task.id, entry.task);
            if (entry.task.status !== "running") terminalRuns.set(taskNotificationId(entry.task.id, entry.task.kind === "agent" ? entry.task.progress.runCount : 1), entry.task);
        }
    }
    return {sequence, tasks: [...tasks.values()], claimedNotificationIds,
        pendingRuns: [...terminalRuns].filter(([id]) => !claimedNotificationIds.has(id)).map(([, task]) => task)};
}

class TaskJournal implements TaskJournalLike {
    private appendTail: Promise<void> = Promise.resolve();
    private readonly cache = new Map<string, CachedJournal>();

    constructor(
        private readonly storage: HiCodeStorageLayout,
        private readonly cwd: string,
    ) {}

    async append(event: TaskEventEnvelope): Promise<void> {
        await this.appendEntry(event);
    }

    async markNotificationClaimed(input: {
        sequence: number;
        sessionId: string;
        taskId: string;
        notificationId: string;
    }): Promise<void> {
        await this.appendEntry({
            version: 6,
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
                throw new Error(`Task Journal is not a safe regular file: ${path}`);
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
                    throw new Error(`Task Journal line exceeds the size limit: ${path}`);
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
                            throw new Error(`Task Journal still exceeds the size limit after compaction: ${path}`);
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
                            throw new Error(`Task Journal still exceeds the size limit after compaction: ${path}`);
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
    storage: HiCodeStorageLayout,
    cwd: string
): TaskJournalLike {
    return new TaskJournal(storage, cwd);
}
