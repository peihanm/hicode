import {DEFAULT_SHELL_WAIT_MS, type TaskWaitWake, waitForTaskActivity} from "./wait.js";
import type {QueuedAgentInput} from "../agent/inputChannel.js";
import {notificationFor, taskNotificationId} from "./notifications.js";
import type {AgentTaskSnapshot, ShellTaskSnapshot, TaskResultReceipt, TaskSessionLike} from "./types.js";

/** Turn-owned result dependencies and receipts; execution state belongs to TaskRuntime. */
export class TaskJoin {
    private readonly pending = new Map<string, "agent" | "shell">();
    private readonly reported = new Set<string>();
    private readonly unacknowledged = new Map<string, TaskResultReceipt>();
    constructor(private readonly tasks: Pick<TaskSessionLike, "get" | "subscribe" | "acknowledgeNotification">) {}

    register(task: AgentTaskSnapshot | ShellTaskSnapshot): void {this.pending.set(task.id, task.kind);}
    record(receipt: TaskResultReceipt): void {
        this.pending.delete(receipt.taskId);
        this.reported.add(receipt.notificationId);
        this.unacknowledged.set(receipt.notificationId, receipt);
    }
    markReported(task: AgentTaskSnapshot | ShellTaskSnapshot): void {
        if (task.status !== "running") this.record({taskId: task.id,
            notificationId: taskNotificationId(task.id, task.kind === "agent" ? task.progress.runCount : 1)});
    }
    async acknowledge(): Promise<void> {
        for (const [id, receipt] of this.unacknowledged) {
            await this.tasks.acknowledgeNotification(receipt);
            this.unacknowledged.delete(id);
        }
    }
    accepts(input: QueuedAgentInput): boolean {
        return input.source !== "task_notification" || !this.reported.has(input.id);
    }
    async consume(input: QueuedAgentInput): Promise<void> {
        if (input.source !== "task_notification" || !input.taskId) return;
        const task = await this.tasks.get(input.taskId);
        if (task && (task.kind === "shell" || task.kind === "agent") && taskNotificationId(task.id, task.kind === "agent" ? task.progress.runCount : 1) === input.id) this.markReported(task);
    }
    async collect(): Promise<QueuedAgentInput[]> {
        const inputs: QueuedAgentInput[] = [];
        for (const [id, kind] of this.pending) {
            const task = await this.tasks.get(id);
            if (!task || task.kind !== kind) throw new Error(`Pending ${kind} result is unavailable: ${id}`);
            if (task.status === "running") continue;
            const notification = notificationFor(task);
            inputs.push({id: notification.notificationId, source: "task_notification", taskId: id,
                content: `<task-notification>\n${notification.message}\nInspect the result, integrate changes and complete verification.\n</task-notification>`});
        }
        return inputs;
    }
    get ids(): readonly string[] {return [...this.pending.keys()];}
    get agentIds(): readonly string[] {return [...this.pending].filter(([, kind]) => kind === "agent").map(([id]) => id);}
    wait(signal: AbortSignal, waitForInput: (signal: AbortSignal) => Promise<void>): Promise<TaskWaitWake> {
        const shellPending = [...this.pending.values()].includes("shell");
        return waitForTaskActivity(this.tasks, this.ids, signal, "result", waitForInput,
            shellPending ? DEFAULT_SHELL_WAIT_MS : undefined);
    }
}
