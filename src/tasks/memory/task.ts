import type {MemoryRuntimeLike} from "../../memory/runtime.js";
import type {ManagedMemoryTask} from "../managed.js";

/** Execute an already registered maintenance task without acquiring Root ownership. */
export async function runMemoryTask(
    task: ManagedMemoryTask,
    memory: MemoryRuntimeLike,
    signal: AbortSignal,
    publishFinished: (task: ManagedMemoryTask) => Promise<void>,
): Promise<void> {
    try {
        signal.throwIfAborted();
        const result = await memory.maintain({sessionId: task.owner.sessionId, signal});
        const {pending} = await memory.status();
        signal.throwIfAborted();
        task.status = "completed";
        task.resultPreview = result.status === "published" ? `Memory published ${result.topics} topics` :
            result.status === "busy" ? "Another process is consolidating" : "Sources in this batch already processed";
        if (pending > 0) task.resultPreview += `;${pending} sources await later maintenance`;
    } catch {
        task.status = signal.aborted ? "cancelled" : "failed";
        task.outputIssue = "Memory maintenance is incomplete; unconsumed sources are retained. Use /memory for status.";
    } finally {
        task.completedAt = new Date().toISOString();
        task.notificationPending = !task.suppressTerminalNotification;
        await publishFinished(task);
    }
}
