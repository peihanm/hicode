import type {ThreadEvent} from "../sdk/protocol.js";
import type {TurnResult} from "../sdk/types.js";
import type {HeadlessOutputFormat, HeadlessRunSummary} from "./types.js";

export function buildHeadlessRunSummary(result: TurnResult): HeadlessRunSummary {
    const reason = result.stopReason;
    const exitCode = reason === "interrupted" ? 130 : reason === "max_turns" ? 3 :
        ["permission_denied", "hook_blocked", "hook_error", "hook_limit"].includes(reason) ? 2 : 0;
    return {...result, ok: exitCode === 0, exitCode};
}

export function formatHeadlessProgress(event: ThreadEvent): string | null {
    if (event.type !== "item.started" && event.type !== "item.completed") return null;
    const item = event.item;
    if (item.type === "tool_call") return event.type === "item.started"
        ? `● ${item.name} ${JSON.stringify(item.arguments).slice(0, 160)}`
        : `  ${(item.resultPreview ?? item.outcome ?? "").slice(0, 220)}`;
    if (item.type === "agent_message" && item.phase === "commentary" && event.type === "item.completed") return `● ${item.text}`;
    if (item.type === "hook" && event.type === "item.completed") return item.execution.userMessage ?? null;
    return null;
}

export function formatHeadlessOutput(summary: HeadlessRunSummary, format: HeadlessOutputFormat): string {
    if (format === "json") return JSON.stringify(summary, null, 2);
    return summary.exitCode === 0 ? summary.finalResponse :
        `${summary.finalResponse}\n\nHeadless stopped: ${summary.stopReason}${summary.abortReason ? ` (${summary.abortReason})` : ""}`.trim();
}

export function formatHeadlessCliError(error: unknown, format: HeadlessOutputFormat): string {
    const message = error instanceof Error ? error.message : String(error);
    return format === "json" ? JSON.stringify({ok: false, exitCode: 1, error: message}, null, 2) : `\x1b[31m${message}\x1b[0m`;
}
