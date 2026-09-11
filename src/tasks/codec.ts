import {z} from "zod";
import type {StopReason} from "../agent/types.js";
import type {PersistedToolResult} from "../toolResults/index.js";
import type {ShellTermination} from "../tools/bash/process.js";
import type {
    AgentTaskSnapshot,
    ShellTaskSnapshot,
    TaskEventEnvelope,
    TaskSnapshot,
    TaskStatus,
} from "./types.js";

export type TaskJournalEntry =
    | TaskEventEnvelope
    | {
    version: 5;
    type: "task_notification_claimed";
    sequence: number;
    sessionId: string;
    taskId: string;
    notificationId: string;
};

const MAX_ID_CHARACTERS = 512;
const MAX_LABEL_CHARACTERS = 256;
const MAX_PATH_CHARACTERS = 16_384;
const MAX_TEXT_CHARACTERS = 128 * 1024;
const MAX_COMMAND_CHARACTERS = 1024 * 1024;

const TASK_STATUSES = new Set<TaskStatus>([
    "running", "completed", "failed", "cancelled",
]);
const STOP_REASONS = new Set<StopReason>([
    "completed", "max_turns", "permission_denied", "hook_blocked", "hook_error", "hook_limit",
    "no_tool_calls", "interrupted",
]);
const ABORT_REASONS = new Set([
    "user-cancel", "sigint", "timeout", "shutdown",
]);
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[]
): boolean {
    const keys = new Set(allowed);
    return Object.keys(value).every((key) => keys.has(key));
}

function boundedString(
    value: unknown,
    max: number,
    allowEmpty = false
): value is string {
    return typeof value === "string" &&
        (allowEmpty || value.length > 0) &&
        value.length <= max;
}

function safeCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isoDate(value: unknown): value is string {
    return boundedString(value, 64) && Number.isFinite(Date.parse(value));
}

function decodePersistedResult(value: unknown): PersistedToolResult | undefined {
    if (!isRecord(value) || !hasOnlyKeys(value, [
        "resultId", "toolCallId", "toolName", "path", "byteLength",
        "originalByteLength", "preview", "complete", "encoding",
    ])) return undefined;
    if (
        !boundedString(value.resultId, MAX_ID_CHARACTERS) ||
        !boundedString(value.toolCallId, MAX_ID_CHARACTERS) ||
        !boundedString(value.toolName, MAX_LABEL_CHARACTERS) ||
        !boundedString(value.path, MAX_PATH_CHARACTERS) ||
        !safeCount(value.byteLength) ||
        !safeCount(value.originalByteLength) ||
        value.originalByteLength < value.byteLength ||
        !boundedString(value.preview, MAX_TEXT_CHARACTERS, true) ||
        typeof value.complete !== "boolean" ||
        (value.complete && value.originalByteLength !== value.byteLength) ||
        value.encoding !== "utf-8"
    ) return undefined;
    return {
        resultId: value.resultId,
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        path: value.path,
        byteLength: value.byteLength,
        originalByteLength: value.originalByteLength,
        preview: value.preview,
        complete: value.complete,
        encoding: "utf-8",
    };
}

function decodeTermination(value: unknown): ShellTermination | undefined {
    if (!isRecord(value) || typeof value.kind !== "string") return undefined;
    if (value.kind === "exit" && hasOnlyKeys(value, ["kind", "code", "signal"])) {
        if (!Number.isSafeInteger(value.code) ||
            (value.signal !== null && !boundedString(value.signal, 32))) return undefined;
        return {kind: "exit", code: value.code as number, signal: value.signal as NodeJS.Signals | null};
    }
    if (value.kind === "aborted" && hasOnlyKeys(value, ["kind", "reason"]) &&
        typeof value.reason === "string" && ABORT_REASONS.has(value.reason)) {
        return {kind: "aborted", reason: value.reason as "user-cancel" | "sigint" | "timeout" | "shutdown"};
    }
    if (value.kind === "timeout" && hasOnlyKeys(value, ["kind", "timeoutMs"]) &&
        safeCount(value.timeoutMs)) {
        return {kind: "timeout", timeoutMs: value.timeoutMs};
    }
    if (value.kind === "output_limit" && hasOnlyKeys(value, ["kind", "maxBuffer"]) &&
        safeCount(value.maxBuffer)) {
        return {kind: "output_limit", maxBuffer: value.maxBuffer};
    }
    if (value.kind === "spawn_error" && hasOnlyKeys(value, ["kind", "error"]) &&
        isRecord(value.error) && hasOnlyKeys(value.error, ["name", "message"]) &&
        boundedString(value.error.message, MAX_TEXT_CHARACTERS, true) &&
        (value.error.name === undefined || boundedString(value.error.name, MAX_LABEL_CHARACTERS))) {
        const error = new Error(value.error.message);
        if (typeof value.error.name === "string") error.name = value.error.name;
        return {kind: "spawn_error", error};
    }
    return undefined;
}

function decodeOwner(value: unknown): {sessionId: string; toolCallId: string} | undefined {
    if (!isRecord(value) || !hasOnlyKeys(value, ["sessionId", "toolCallId"]) ||
        !boundedString(value.sessionId, MAX_ID_CHARACTERS) ||
        !boundedString(value.toolCallId, MAX_ID_CHARACTERS)) return undefined;
    return {sessionId: value.sessionId, toolCallId: value.toolCallId};
}

function decodeCommon(value: Record<string, unknown>): {
    id: string;
    owner: {sessionId: string; toolCallId: string};
    status: TaskStatus;
    startedAt: string;
    completedAt?: string;
    outputIssue?: string;
} | undefined {
    const owner = decodeOwner(value.owner);
    if (
        !boundedString(value.id, MAX_ID_CHARACTERS) ||
        !owner ||
        typeof value.status !== "string" ||
        !TASK_STATUSES.has(value.status as TaskStatus) ||
        !isoDate(value.startedAt) ||
        (value.completedAt !== undefined && !isoDate(value.completedAt)) ||
        (value.status === "running" && value.completedAt !== undefined) ||
        (value.status !== "running" && value.completedAt === undefined) ||
        (value.outputIssue !== undefined &&
            !boundedString(value.outputIssue, MAX_TEXT_CHARACTERS, true))
    ) return undefined;
    return {
        id: value.id,
        owner,
        status: value.status as TaskStatus,
        startedAt: value.startedAt,
        ...(typeof value.completedAt === "string" ? {completedAt: value.completedAt} : {}),
        ...(typeof value.outputIssue === "string" ? {outputIssue: value.outputIssue} : {}),
    };
}

function decodeShellTask(value: Record<string, unknown>): ShellTaskSnapshot | undefined {
    if (!hasOnlyKeys(value, [
        "id", "kind", "owner", "command", "cwd", "status", "startedAt",
        "completedAt", "output", "outputResult", "outputIssue", "termination", "executionMode",
    ])) return undefined;
    const common = decodeCommon(value);
    const outputResult = value.outputResult === undefined
        ? undefined
        : decodePersistedResult(value.outputResult);
    const termination = value.termination === undefined
        ? undefined
        : decodeTermination(value.termination);
    if (
        value.kind !== "shell" || !common ||
        (value.executionMode !== "sandbox" && value.executionMode !== "host") ||
        !boundedString(value.command, MAX_COMMAND_CHARACTERS) ||
        !boundedString(value.cwd, MAX_PATH_CHARACTERS) ||
        !boundedString(value.output, MAX_TEXT_CHARACTERS, true) ||
        (value.outputResult !== undefined && !outputResult) ||
        (value.termination !== undefined && !termination)
    ) return undefined;
    return {
        ...common,
        kind: "shell",
        executionMode: value.executionMode,
        command: value.command,
        cwd: value.cwd,
        output: value.output,
        ...(outputResult ? {outputResult} : {}),
        ...(termination ? {termination} : {}),
    };
}

function decodeAgentTask(value: Record<string, unknown>): AgentTaskSnapshot | undefined {
    if (!hasOnlyKeys(value, [
        "id", "kind", "cwd", "owner", "agentType", "agentName", "description", "status",
        "startedAt", "completedAt", "progress", "reason", "resultPreview",
        "outputResult", "transcriptPath", "outputIssue",
    ])) return undefined;
    const common = decodeCommon(value);
    if (!isRecord(value.progress) || !hasOnlyKeys(value.progress, [
        "runCount", "iterations", "toolUseCount", "pendingMessages",
        "tokenCount", "lastActivity",
    ])) return undefined;
    const outputResult = value.outputResult === undefined
        ? undefined
        : decodePersistedResult(value.outputResult);
    if (
        value.kind !== "agent" || !common || !boundedString(value.cwd, MAX_PATH_CHARACTERS) ||
        !boundedString(value.agentType, MAX_LABEL_CHARACTERS) ||
        (value.agentName !== undefined && !boundedString(value.agentName, MAX_LABEL_CHARACTERS)) ||
        !boundedString(value.description, MAX_TEXT_CHARACTERS) ||
        !safeCount(value.progress.runCount) ||
        value.progress.runCount === 0 ||
        !safeCount(value.progress.iterations) ||
        !safeCount(value.progress.toolUseCount) ||
        !safeCount(value.progress.pendingMessages) ||
        (value.progress.tokenCount !== undefined && !safeCount(value.progress.tokenCount)) ||
        (value.progress.lastActivity !== undefined &&
            !boundedString(value.progress.lastActivity, MAX_LABEL_CHARACTERS)) ||
        (value.reason !== undefined &&
            (typeof value.reason !== "string" || !STOP_REASONS.has(value.reason as StopReason))) ||
        (value.resultPreview !== undefined &&
            !boundedString(value.resultPreview, MAX_TEXT_CHARACTERS, true)) ||
        (value.outputResult !== undefined && !outputResult) ||
        (value.transcriptPath !== undefined &&
            !boundedString(value.transcriptPath, MAX_PATH_CHARACTERS))
    ) return undefined;
    return {
        ...common,
        kind: "agent",
        cwd: value.cwd,
        agentType: value.agentType,
        ...(typeof value.agentName === "string" ? {agentName: value.agentName} : {}),
        description: value.description,
        progress: {
            runCount: value.progress.runCount,
            iterations: value.progress.iterations,
            toolUseCount: value.progress.toolUseCount,
            pendingMessages: value.progress.pendingMessages,
            ...(typeof value.progress.tokenCount === "number"
                ? {tokenCount: value.progress.tokenCount}
                : {}),
            ...(typeof value.progress.lastActivity === "string"
                ? {lastActivity: value.progress.lastActivity}
                : {}),
        },
        ...(typeof value.reason === "string" ? {reason: value.reason as StopReason} : {}),
        ...(typeof value.resultPreview === "string" ? {resultPreview: value.resultPreview} : {}),
        ...(outputResult ? {outputResult} : {}),
        ...(typeof value.transcriptPath === "string" ? {transcriptPath: value.transcriptPath} : {}),
    };
}

const memoryTaskSchema=z.object({id:z.string().min(1).max(512),kind:z.literal("memory"),owner:z.object({sessionId:z.string().min(1).max(512),turnId:z.string().min(1).max(512)}).strict(),
 status:z.enum(["running","completed","failed","cancelled"]),startedAt:z.string().datetime(),completedAt:z.string().datetime().optional(),resultPreview:z.string().max(1000).optional(),outputIssue:z.string().max(128*1024).optional()}).strict()
 .refine(task=>task.status==="running"?task.completedAt===undefined:task.completedAt!==undefined);

function decodeTask(value: unknown): TaskSnapshot | undefined {
    if (!isRecord(value)) return undefined;
    if(value.kind==="memory"){const parsed=memoryTaskSchema.safeParse(value);return parsed.success?parsed.data:undefined;}
    return value.kind === "shell"
        ? decodeShellTask(value)
        : value.kind === "agent"
            ? decodeAgentTask(value)
            : undefined;
}

export function decodeTaskJournalEntry(
    value: unknown,
    expectedSessionId: string
): TaskJournalEntry | undefined {
    if (!isRecord(value) || value.version !== 5 || !safeCount(value.sequence) ||
        value.sequence === 0 || value.sessionId !== expectedSessionId) return undefined;
    if (value.type === "task_notification_claimed") {
        if (!hasOnlyKeys(value, ["version", "type", "sequence", "sessionId", "taskId", "notificationId"]) ||
            !boundedString(value.taskId, MAX_ID_CHARACTERS) || typeof value.notificationId !== "string" || !/^[a-f0-9]{64}$/.test(value.notificationId)) return undefined;
        return {
            version: 5,
            type: "task_notification_claimed",
            sequence: value.sequence,
            sessionId: expectedSessionId,
            taskId: value.taskId,
            notificationId: value.notificationId,
        };
    }
    if (
        value.type !== "task_started" &&
        value.type !== "task_progress" &&
        value.type !== "task_finished"
    ) return undefined;
    if (!hasOnlyKeys(value, ["version", "type", "sequence", "sessionId", "task"])) {
        return undefined;
    }
    const task = decodeTask(value.task);
    if (!task || task.owner.sessionId !== expectedSessionId) return undefined;
    if (
        (value.type === "task_started" && task.status !== "running") ||
        (value.type === "task_finished" && task.status === "running")
    ) return undefined;
    return {
        version: 5,
        type: value.type,
        sequence: value.sequence,
        sessionId: expectedSessionId,
        task,
    };
}

function errorReplacer(_key: string, value: unknown): unknown {
    return value instanceof Error
        ? {name: value.name, message: value.message}
        : value;
}

export function serializeTaskJournalEntry(entry: TaskJournalEntry): string {
    const serialized = JSON.stringify(entry, errorReplacer);
    const normalized = decodeTaskJournalEntry(JSON.parse(serialized), entry.sessionId);
    if (!normalized) throw new Error("Refusing to persist invalid Task Journal entry");
    return JSON.stringify(normalized, errorReplacer);
}
