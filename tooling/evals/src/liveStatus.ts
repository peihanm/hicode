import type {InteractionRequest, ThreadEvent} from "pillar/sdk";
import type {EvalLiveStatus} from "./types.js";

export function createEvalLiveStatus(nowMs: number): EvalLiveStatus {
    return {
        phase: "starting",
        detail: "preparing workspace",
        startedAtMs: nowMs,
        lastSignalAtMs: nowMs,
        sequence: 0,
    };
}

export function reduceEvalLiveStatus(
    current: EvalLiveStatus,
    event: ThreadEvent
): EvalLiveStatus {
    const signaledAt = parseTimestamp(event.emittedAt, current.lastSignalAtMs);
    const base = {
        ...current,
        lastSignalAtMs: signaledAt,
        sequence: event.sequence,
    };
    switch (event.type) {
        case "thread.started":
            return {...base, phase: "starting", detail: "thread started"};
        case "turn.started":
            return {...base, phase: "model_waiting", detail: "waiting for model"};
        case "turn.progress":
            return {
                ...base,
                phase: event.phase,
                detail: progressDetail(event),
                estimatedOutputTokens: event.estimatedOutputTokens,
            };
        case "item.started":
            if (event.item.type === "tool_call") {
                return {
                    ...base,
                    phase: "tool",
                    detail: `running ${event.item.name}`,
                };
            }
            if (event.item.type === "interaction") {
                return {
                    ...base,
                    phase: "interaction",
                    detail: interactionDetail(event.item.request),
                };
            }
            return {
                ...base,
                phase: "item",
                detail: `updating ${event.item.type}`,
            };
        case "item.updated":
            return base;
        case "item.completed":
            return {
                ...base,
                phase: event.item.type === "interaction"
                    ? "interaction"
                    : event.item.type === "tool_call"
                        ? "tool"
                        : "item",
                detail: `completed ${event.item.type}`,
            };
        case "turn.completed":
            return {...base, phase: "completed", detail: event.stopReason};
        case "turn.failed":
            return {...base, phase: "failed", detail: event.error.code};
    }
}

export function formatEvalHeartbeat(
    status: EvalLiveStatus,
    nowMs: number
): string {
    const elapsedMs = Math.max(0, nowMs - status.startedAtMs);
    const idleMs = Math.max(0, nowMs - status.lastSignalAtMs);
    const health = status.phase === "failed"
        ? "failed"
        : status.phase === "completed"
            ? "completed"
            : status.phase === "stalled" || idleMs >= 120_000
                ? "stalled"
                : idleMs >= 30_000
                    ? "quiet"
                    : "active";
    const tokens = status.estimatedOutputTokens === undefined
        ? ""
        : ` | ~${status.estimatedOutputTokens} output tokens`;
    return `[eval ${formatDuration(elapsedMs)}] ${health} | ${status.detail}` +
        `${tokens} | last signal ${formatAge(idleMs)} ago`;
}

function progressDetail(
    event: Extract<ThreadEvent, {type: "turn.progress"}>
): string {
    switch (event.phase) {
        case "model_waiting":
            return "waiting for model";
        case "reasoning":
            return "model reasoning";
        case "content":
            return "model writing response";
        case "tool_input":
            return `model preparing ${event.toolName ?? "tool call"}`;
        case "retrying":
            return "provider retrying";
        case "stalled":
            return event.idleMilliseconds === undefined
                ? "model stream stalled"
                : `model stream stalled ${formatAge(event.idleMilliseconds)}`;
    }
}

function interactionDetail(
    request: InteractionRequest
): string {
    return request.kind === "permission"
        ? `resolving permission ${request.toolName ?? ""}`.trim()
        : `resolving ${request.kind}`;
}

function parseTimestamp(value: string, fallback: number): number {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatAge(milliseconds: number): string {
    if (milliseconds < 1_000) return "<1s";
    return `${Math.floor(milliseconds / 1_000)}s`;
}
