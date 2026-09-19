import type {QueuedAgentInput} from "../agent/inputChannel.js";
import {notificationFor, taskNotificationId} from "./notifications.js";
import type {AgentTaskSnapshot, TaskSessionLike} from "./types.js";

/** Subscribe before reading so completion between registration and inspection cannot be lost. */
export function waitForAgentTasks(tasks: TaskSessionLike, ids: readonly string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            unsubscribe();
            signal.removeEventListener("abort", abort);
            if (error !== undefined) reject(error); else resolve();
        };
        const abort = () => finish(signal.reason);
        const inspect = async () => {
            try {
                const snapshots = await Promise.all(ids.map(id => tasks.get(id)));
                if (snapshots.some(task => !task || task.kind !== "agent")) throw new Error("Cannot wait for an unavailable Agent task");
                if (!snapshots.length || snapshots.some(task => task?.status !== "running")) finish();
            } catch (error) {finish(error);}
        };
        unsubscribe = tasks.subscribe(event => {
            if (ids.includes(event.task.id) && event.type === "task_finished") void inspect();
        });
        signal.addEventListener("abort", abort, {once: true});
        if (signal.aborted) abort(); else void inspect();
    });
}

/** Race task completion against safe-boundary input, cancelling the losing subscription. */
export async function waitForAgentActivity(
    tasks: TaskSessionLike,
    ids: readonly string[],
    signal: AbortSignal,
    waitForInput: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
    signal.throwIfAborted();
    const wake = new AbortController();
    const waitSignal = AbortSignal.any([signal, wake.signal]);
    try {
        await Promise.race([
            waitForAgentTasks(tasks, ids, waitSignal),
            waitForInput(waitSignal),
        ]);
        signal.throwIfAborted();
    } finally {wake.abort();}
}

/** Turn-owned dependency IDs only; task state remains owned by TaskRuntime. */
export class AgentTaskJoin {
    private readonly pending = new Set<string>();
    private readonly reported = new Set<string>();
    private readonly unacknowledged = new Map<string, string>();
    constructor(private readonly tasks: TaskSessionLike) {}

    register(task: AgentTaskSnapshot): void {this.pending.add(task.id);}

    markReported(task: AgentTaskSnapshot): void {
        if (task.status === "running") return;
        this.pending.delete(task.id);
        const notificationId = taskNotificationId(task.id, task.progress.runCount);
        this.reported.add(notificationId);
        this.unacknowledged.set(notificationId, task.id);
    }

    /** Called only after the Session has durably saved the corresponding History/tool result. */
    async acknowledgeReported(): Promise<void> {
        for (const [notificationId, taskId] of this.unacknowledged) {
            await this.tasks.acknowledgeNotification({notificationId, taskId});
            this.unacknowledged.delete(notificationId);
        }
    }

    accepts(input: QueuedAgentInput): boolean {
        return input.source !== "task_notification" || !this.reported.has(input.id);
    }

    async consume(input: QueuedAgentInput): Promise<void> {
        if (input.source !== "task_notification" || !input.taskId) return;
        const task = await this.tasks.get(input.taskId);
        if (task?.kind === "agent" && taskNotificationId(task.id, task.progress.runCount) === input.id) this.markReported(task);
    }

    async collect(): Promise<QueuedAgentInput[]> {
        const inputs: QueuedAgentInput[] = [];
        for (const id of this.pending) {
            const task = await this.tasks.get(id);
            if (!task || task.kind !== "agent") throw new Error(`Delegated Agent task is unavailable: ${id}`);
            if (task.status === "running") continue;
            const notification = notificationFor(task);
            inputs.push({id: notification.notificationId, source: "task_notification", taskId: id,
                content: `<task-notification>\n${notification.message}\nInspect the result, integrate the changes and complete the remaining verification.\n</task-notification>`});
        }
        return inputs;
    }

    get ids(): readonly string[] {return [...this.pending];}
    wait(signal: AbortSignal, waitForInput: (signal: AbortSignal) => Promise<void>): Promise<void> {
        return waitForAgentActivity(this.tasks, this.ids, signal, waitForInput);
    }
}
