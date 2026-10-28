import type {AgentTaskSnapshot, TaskSnapshot} from "./types.js";

export function isTaskId(value: string): boolean {
    return /^t_[a-f0-9]{12}$/.test(value);
}

export function formatTaskHeader(task: Pick<TaskSnapshot, "id" | "kind" | "status">): string {
    return `task_id: ${task.id}\nkind: ${task.kind}\nstatus: ${task.status}`;
}

export function formatTaskSummary(task: TaskSnapshot): string {
    const label = task.kind === "shell" ? task.command : task.kind === "agent" ? task.description : task.kind === "review" ? `Advisory task review: rounds ${task.fromRound}-${task.toRound}; do not wait for this task` : "Memory maintenance";
    return `${formatTaskHeader(task)}${task.kind === "shell" ? `\nphase: ${task.phase}` : ""}\n${label.replace(/\s+/g, " ").slice(0, 160)}`;
}

export function agentRunTiming(task: AgentTaskSnapshot, now = Date.now()): {runMs: number; totalMs: number} {
    const runMs = Math.max(0, (task.completedAt ? Date.parse(task.completedAt) : now) - Date.parse(task.progress.runStartedAt));
    return {runMs, totalMs: task.progress.previousDurationMs + runMs};
}
