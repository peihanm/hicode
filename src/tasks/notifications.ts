import {shellResultReceipt} from "../tools/bash/receipt.js";
import {formatTaskHeader} from "./format.js";
import {createHash} from "node:crypto";
import type {ManagedTask, ManagedShellTask} from "./managed.js";
import type {TaskNotification, TaskSnapshot,} from "./types.js";

type SnapshotTask = (task: ManagedTask) => Promise<TaskSnapshot>;
export function isExpectedShellShutdown(task: Pick<ManagedShellTask, "status" | "termination" | "outputIssue">): boolean {
    return task.status === "cancelled" && task.termination?.kind === "aborted" &&
        task.termination.reason === "shutdown" && !task.outputIssue;
}

export function taskNotificationId(taskId: string, runCount: number): string {
    return createHash("sha256").update(JSON.stringify([taskId, runCount])).digest("hex");
}

function compactLine(value: string, max = 180): string {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function shellTermination(task: Extract<TaskSnapshot, {kind: "shell"}>): string {
    const termination = task.termination;
    if (!termination) return task.status;
    if (termination.kind === "exit") {
        return termination.signal
            ? `signal ${termination.signal}`
            : `exit ${termination.code}`;
    }
    if (termination.kind === "timeout") return `timeout ${termination.timeoutMs}ms`;
    if (termination.kind === "aborted") return `cancelled · ${termination.reason}`;
    if (termination.kind === "output_limit") {
        return `output limit ${termination.maxBuffer} bytes`;
    }
    return `spawn error · ${compactLine(termination.error.message)}`;
}

function shellOutputSummary(output: string): string | undefined {
    const lines = output
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const relevant = lines.find((line) =>
        // External process output may report failure in English or Chinese.
        /(?:\bError\b|EADDRINUSE|ERR_|\berror\b|failed|\u5931\u8d25)/i.test(line)
    ) ?? lines.at(-1);
    return relevant ? compactLine(relevant) : undefined;
}

function notificationSummary(task: TaskSnapshot): string {
    if (task.kind === "shell") {
        const parts = [
            shellTermination(task),
            task.outputIssue ? compactLine(task.outputIssue) : undefined,
            task.status === "failed" ? shellOutputSummary(task.output) : undefined,
        ].filter((part): part is string => Boolean(part));
        return [...new Set(parts)].join(" · ");
    }
    if (task.outputIssue) return compactLine(task.outputIssue);
    if (task.status === "completed" && task.resultPreview) {
        return compactLine(task.resultPreview);
    }
    return task.kind==="agent"?task.reason ?? task.status:task.status;
}

function shellCommandExitMessage(task: TaskSnapshot, label: string, output: string): string | undefined {
    if (task.kind !== "shell" || task.status !== "failed" || task.outputIssue || task.termination?.kind !== "exit") return undefined;
    const result = task.termination.signal
        ? `terminated by signal ${task.termination.signal}`
        : `exited with code ${task.termination.code}`;
    const detail = shellOutputSummary(task.output);
    return `${formatTaskHeader(task)}\n${compactLine(label)} ${result}${detail ? ` · ${detail}` : ""}${output}.`;
}

export function notificationFor(task: TaskSnapshot): TaskNotification {
    const label = task.kind === "review" ? `Task review: rounds ${task.fromRound}-${task.toRound}` : task.kind === "memory"?"Memory maintenance":task.kind === "shell"
        ? task.command
        : task.agentName ?? task.description;
    const messageLabel = task.kind === "agent"
        ? `${task.agentName ? `${task.agentName} (${task.agentType})` : task.agentType} · ${task.description}`
        : label;
    const result = task.kind==="memory" || task.kind === "review" ?undefined:task.outputResult;
    const resultId = result?.resultId;
    const output = resultId
        ? `; full output saved at ${JSON.stringify(result?.path)}; read with read_file`
        : "";
    const records = task.kind === "agent" && task.transcriptPath ? `; inspect conversation and execution records with task status (task_id: ${task.id})` : "";
    const summary = notificationSummary(task);
    const message = shellCommandExitMessage(task, messageLabel, output) ??
        `${formatTaskHeader(task)}\n${compactLine(messageLabel)} is ${
            task.status === "completed"
                ? "completed"
                : task.status === "interrupted"
                    ? "interrupted"
                    : task.status === "cancelled"
                    ? "cancelled"
                    : "failed"
        }: ${summary}${output}${records}.`;
    return {
        notificationId: taskNotificationId(task.id, task.kind === "agent" ? task.progress.runCount : 1),
        taskId: task.id,
        sessionId: task.owner.sessionId,
        ...(task.kind === "shell" || task.kind === "agent" ?{ownerToolCallId:task.owner.toolCallId}:{}),
        kind: task.kind,
        label,
        status: task.status as TaskNotification["status"],
        summary,
        ...(task.kind === "shell" && task.termination
            ? {shellResult: shellResultReceipt(task.termination, !!task.outputIssue)} : {}),
        ...(resultId ? {resultId} : {}),
        message,
    };
}

export class TaskNotificationCenter {
    private readonly previousRuns = new Map<string, TaskSnapshot>();

    rememberPrevious(snapshot: TaskSnapshot): void {
        const id = taskNotificationId(snapshot.id, snapshot.kind === "agent" ? snapshot.progress.runCount : 1);
        if (!this.previousRuns.has(id) && [...this.previousRuns.values()].filter(task => task.owner.sessionId === snapshot.owner.sessionId).length >= 32) {
            throw new Error("Undelivered Agent notifications reached the limit; receive task notifications first");
        }
        this.previousRuns.set(id, snapshot);
    }

    hasPrevious(sessionId: string, taskId: string, notificationId: string): boolean {
        const snapshot = this.previousRuns.get(notificationId);
        return snapshot?.owner.sessionId === sessionId && snapshot.id === taskId;
    }

    acknowledgePrevious(notificationId: string): void { this.previousRuns.delete(notificationId); }

    private readonly archivedPending = new Set<string>();

    rememberArchived(taskId: string, claimed: boolean): void {
        if (!claimed) this.archivedPending.add(taskId);
    }

    hasArchivedPending(taskId: string): boolean { return this.archivedPending.has(taskId); }
    acknowledgeArchived(taskId: string): void { this.archivedPending.delete(taskId); }

    async pending(
        sessionId: string,
        tasks: Iterable<ManagedTask>,
        archived: Iterable<TaskSnapshot>,
        snapshotTask: SnapshotTask
    ): Promise<readonly TaskNotification[]> {
        const notifications: TaskNotification[] = [];
        for (const task of tasks) {
            if (task.owner.sessionId !== sessionId || !task.notificationPending || task.status === "running") continue;
            const snapshot = await snapshotTask(task);
            if (snapshot.status !== "running") notifications.push(notificationFor(snapshot));
        }
        for (const task of archived) {
            if (task.owner.sessionId === sessionId && this.archivedPending.has(task.id) && task.status !== "running") {
                notifications.push(notificationFor(task));
            }
        }
        for (const snapshot of this.previousRuns.values()) {
            if (snapshot.owner.sessionId !== sessionId) continue;
            const notification = notificationFor(snapshot);
            if (!notifications.some(current => current.notificationId === notification.notificationId)) notifications.push(notification);
        }
        return notifications;
    }
}
