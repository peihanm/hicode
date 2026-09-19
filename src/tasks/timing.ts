import type {AgentTaskSnapshot} from "./types.js";

export function agentRunTiming(task: AgentTaskSnapshot, now = Date.now()): {runMs: number; totalMs: number} {
    const runMs = Math.max(0, (task.completedAt ? Date.parse(task.completedAt) : now) - Date.parse(task.progress.runStartedAt));
    return {runMs, totalMs: task.progress.previousDurationMs + runMs};
}
