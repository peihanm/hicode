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
        /(?:\bError\b|EADDRINUSE|ERR_|\berror\b|failed|失败)/i.test(line)
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

function notificationFor(task: TaskSnapshot): TaskNotification {
    const label = task.kind === "memory"?"Memory 维护":task.kind === "shell"
        ? task.command
        : `${task.agentName ? `${task.agentName} (${task.agentType})` : task.agentType} · ${task.description}`;
    const result = task.kind==="memory"?undefined:task.outputResult;
    const resultId = result?.resultId;
    const output = resultId
        ? `，完整输出见保存文件 ${JSON.stringify(result?.path)}，可用 read_file 读取`
        : "";
    const worktree = task.kind === "agent" && task.worktree
        ? task.worktree.state === "changed"
            ? `；Worktree 已保留（${task.worktree.changedFiles.length + (task.worktree.omittedChangedFiles ?? 0)} 个变更文件，${task.worktree.commitsAhead ?? 0} 个新 Commit）。先用 task status 查看实时状态，在 Worktree 中检查、测试并 Commit，再用 Git cherry-pick 集成；完成后可 task discard。Git 集成不受 /rewind 的文件恢复保证覆盖`
            : task.worktree.cleanupReason === "no_changes"
                ? "；Worktree 无工作产物，已自动清理"
                : `；Worktree 状态 ${task.worktree.state}`
        : "";
    const summary = notificationSummary(task);
    return {
        notificationId: taskNotificationId(task.id, task.kind === "agent" ? task.progress.runCount : 1),
        taskId: task.id,
        sessionId: task.owner.sessionId,
        ...(task.kind!=="memory"?{ownerToolCallId:task.owner.toolCallId}:{}),
        kind: task.kind,
        label,
        status: task.status as TaskNotification["status"],
        summary,
        ...(resultId ? {resultId} : {}),
        message: `后台${task.kind === "shell" ? "任务" : " Agent"} ${task.id}（${label}）已${
            task.status === "completed"
                ? "完成"
                : task.status === "cancelled"
                    ? "取消"
                    : "失败"
        }：${summary}${output}${worktree}。`,
    };
}

export class TaskNotificationCenter {
    private readonly previousRuns = new Map<string, TaskSnapshot>();

    rememberPrevious(snapshot: TaskSnapshot): void {
        const id = taskNotificationId(snapshot.id, snapshot.kind === "agent" ? snapshot.progress.runCount : 1);
        if (!this.previousRuns.has(id) && [...this.previousRuns.values()].filter(task => task.owner.sessionId === snapshot.owner.sessionId).length >= 32) {
            throw new Error("未交付的 Agent 运行通知已达到上限，请先接收任务通知");
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
