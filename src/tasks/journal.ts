import {appendFile, mkdir, readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {getSessionStorageDirectory} from "../persistence/index.js";
import type {TaskEventEnvelope, TaskSnapshot} from "./types.js";

type TaskJournalEntry =
    | TaskEventEnvelope
    | {
    version: 2;
    type: "task_notification_claimed";
    sequence: number;
    sessionId: string;
    taskId: string;
};

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
    cwd: string,
    sessionId: string,
    projectsRoot?: string
): string {
    return join(
        getSessionStorageDirectory(cwd, sessionId, projectsRoot),
        "tasks",
        "events.jsonl"
    );
}

function isWorktreeSnapshot(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const worktree = value as Record<string, unknown>;
    if (
        typeof worktree.path !== "string" ||
        typeof worktree.branch !== "string" ||
        typeof worktree.baseCommit !== "string" ||
        !/^[0-9a-f]{40,64}$/i.test(worktree.baseCommit) ||
        typeof worktree.sourceHadChanges !== "boolean" ||
        (
            worktree.state !== "active" &&
            worktree.state !== "changed" &&
            worktree.state !== "cleaned"
        ) ||
        !Array.isArray(worktree.changedFiles) ||
        worktree.changedFiles.length > 500
    ) return false;
    if (
        worktree.omittedChangedFiles !== undefined &&
        (
            typeof worktree.omittedChangedFiles !== "number" ||
            !Number.isSafeInteger(worktree.omittedChangedFiles) ||
            worktree.omittedChangedFiles < 0
        )
    ) return false;
    if (
        (worktree.state === "cleaned" &&
            worktree.cleanupReason !== "no_changes" &&
            worktree.cleanupReason !== "explicit_discard") ||
        (worktree.state !== "cleaned" && worktree.cleanupReason !== undefined) ||
        (worktree.dirty !== undefined && typeof worktree.dirty !== "boolean") ||
        (worktree.commitsAhead !== undefined &&
            (typeof worktree.commitsAhead !== "number" ||
                !Number.isSafeInteger(worktree.commitsAhead) ||
                worktree.commitsAhead < 0)) ||
        (worktree.issue !== undefined &&
            (typeof worktree.issue !== "string" || worktree.issue.length > 8_000))
    ) return false;
    return worktree.changedFiles.every((file: unknown) => {
        if (!file || typeof file !== "object") return false;
        const change = file as Record<string, unknown>;
        return typeof change.path === "string" &&
            change.path.length <= 4_096 &&
            (
                change.originalPath === undefined ||
                (typeof change.originalPath === "string" && change.originalPath.length <= 4_096)
            ) &&
            (
                change.kind === "create" ||
                change.kind === "update" ||
                change.kind === "delete" ||
                change.kind === "rename" ||
                change.kind === "copy" ||
                change.kind === "conflict" ||
                change.kind === "type-change"
            );
    });
}

function isTaskSnapshot(value: unknown): value is TaskSnapshot {
    if (!value || typeof value !== "object") return false;
    const task = value as Partial<TaskSnapshot>;
    const kindFieldsValid = task.kind === "shell"
        ? typeof task.command === "string" && typeof task.cwd === "string"
        : task.kind === "agent" &&
            (task.worktree === undefined || isWorktreeSnapshot(task.worktree));
    return typeof task.id === "string" &&
        (task.kind === "shell" || task.kind === "agent") &&
        kindFieldsValid &&
        (task.status === "running" ||
            task.status === "completed" ||
            task.status === "failed" ||
            task.status === "cancelled") &&
        typeof task.startedAt === "string" &&
        Boolean(task.owner) &&
        typeof task.owner?.sessionId === "string" &&
        typeof task.owner?.toolCallId === "string";
}

function parseEntry(line: string): TaskJournalEntry | undefined {
    try {
        const entry = JSON.parse(line) as Partial<TaskJournalEntry>;
        if (
            entry.version !== 2 ||
            typeof entry.sequence !== "number" ||
            typeof entry.sessionId !== "string"
        ) return undefined;
        if (entry.type === "task_notification_claimed") {
            return typeof entry.taskId === "string"
                ? entry as TaskJournalEntry
                : undefined;
        }
        if (
            (entry.type === "task_started" ||
                entry.type === "task_progress" ||
                entry.type === "task_finished") &&
            isTaskSnapshot(entry.task)
        ) return entry as TaskJournalEntry;
    } catch {
        return undefined;
    }
    return undefined;
}

export class TaskJournal implements TaskJournalLike {
    private appendTail: Promise<void> = Promise.resolve();

    constructor(
        private readonly cwd: string,
        private readonly projectsRoot?: string
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
        let content: string;
        try {
            content = await readFile(
                journalPath(this.cwd, sessionId, this.projectsRoot),
                "utf8"
            );
        } catch (error) {
            if (
                error && typeof error === "object" && "code" in error &&
                (error as {code?: string}).code === "ENOENT"
            ) {
                return {sequence: 0, tasks: [], claimedTaskIds: new Set()};
            }
            throw error;
        }
        const tasks = new Map<string, TaskSnapshot>();
        const claimedTaskIds = new Set<string>();
        let sequence = 0;
        for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            const entry = parseEntry(line);
            if (!entry) break;
            sequence = Math.max(sequence, entry.sequence);
            if (entry.sessionId !== sessionId) continue;
            if (entry.type === "task_notification_claimed") {
                claimedTaskIds.add(entry.taskId);
            } else {
                tasks.set(entry.task.id, entry.task);
            }
        }
        return {
            sequence,
            tasks: [...tasks.values()],
            claimedTaskIds,
        };
    }

    private async appendEntry(entry: TaskJournalEntry): Promise<void> {
        const append = this.appendTail
            .catch(() => undefined)
            .then(async () => {
                const path = journalPath(
                    this.cwd,
                    entry.sessionId,
                    this.projectsRoot
                );
                await mkdir(dirname(path), {recursive: true, mode: 0o700});
                await appendFile(path, `${JSON.stringify(entry)}\n`, {
                    encoding: "utf8",
                    mode: 0o600,
                });
            });
        this.appendTail = append;
        await append;
    }
}

export function createTaskJournal(cwd: string): TaskJournalLike {
    return new TaskJournal(cwd);
}
