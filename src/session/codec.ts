import {contentText, imageReferenceSchema} from "../images/content.js";
import {z} from "zod";
import {reasoningStateSchema} from "../llm/reasoning.js";
import {archiveRecordSchema} from "./archiveSchema.js";
import type {Message} from "../llm/types.js";
import {isPermissionMode} from "../permissions/index.js";
import {isCollaborationMode} from "../collaboration/index.js";
import {getProjectKey} from "../persistence/index.js";
import {normalizeRuntimeQueuedMessages} from "../runtime/messageQueue.js";
import {
    MAX_LOADED_DEFERRED_TOOLS,
    type ToolDiscoverySnapshot,
} from "../tools/discoveryState.js";
import {limitPersistedUIEvents, type PersistedUIEvent,} from "./uiEvents.js";
import {
    SESSION_ENTRY_VERSION,
    type SessionEntry,
    type SessionIndexEntry,
    type SessionSnapshotEntry,
} from "./types.js";

const MAX_PERSISTED_TOOL_NAME_CHARS = 256;
const MAX_SESSION_MESSAGES = 20_000;
const MAX_SESSION_CONVERSATION_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_CONTENT_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_CALLS_PER_MESSAGE = 1_024;
const MAX_TODOS = 1_024;
const MAX_UI_EVENTS = 4_096;
const MAX_ID_CHARS = 512;
const MAX_PATH_CHARS = 16_384;
const MAX_MODEL_CHARS = 512;
const MAX_SUMMARY_CHARS = 120;
const MAX_SESSION_INDEX_ENTRIES = 10_000;

export interface SessionHistorySummary {
    summary?: string;
}

function byteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function boundedString(maxBytes: number, allowEmpty = true) {
    return z.string().refine(
        (value) => (allowEmpty || value.length > 0) && byteLength(value) <= maxBytes
    );
}

const idSchema = z.string().min(1).max(MAX_ID_CHARS);
const timestampSchema = z.string().max(64).refine(
    (value) => Number.isFinite(Date.parse(value))
);
const permissionModeSchema = z.custom<SessionSnapshotEntry["permissionMode"]>(
    isPermissionMode
);
const collaborationModeSchema = z.custom<SessionSnapshotEntry["collaborationMode"]>(
    isCollaborationMode
);
const nonNegativeIntegerSchema = z.number().int().nonnegative().max(
    Number.MAX_SAFE_INTEGER
);

const toolCallSchema = z.object({
    id: idSchema,
    type: z.literal("function"),
    function: z.object({
        name: z.string().min(1).max(MAX_PERSISTED_TOOL_NAME_CHARS),
        arguments: boundedString(MAX_TOOL_ARGUMENT_BYTES),
    }).strict(),
}).strict();

const messageSchema = z.discriminatedUnion("role", [
    z.object({
        role: z.literal("user"),
        origin: z.enum(["user", "task_notification", "runtime", "compaction", "agent"]),
        content: z.union([boundedString(MAX_MESSAGE_CONTENT_BYTES), z.array(z.union([z.object({type: z.literal("text"), text: boundedString(MAX_MESSAGE_CONTENT_BYTES)}).strict(), imageReferenceSchema])).min(1).max(32)]),
    }).strict(),
    z.object({
        role: z.literal("assistant"),
        content: boundedString(MAX_MESSAGE_CONTENT_BYTES).nullable(),
        tool_calls: z.array(toolCallSchema).max(MAX_TOOL_CALLS_PER_MESSAGE).optional(),
        reasoning: reasoningStateSchema.optional(),
    }).strict(),
    z.object({
        role: z.literal("tool"),
        content: z.union([boundedString(MAX_MESSAGE_CONTENT_BYTES), z.array(z.union([z.object({type: z.literal("text"), text: boundedString(MAX_MESSAGE_CONTENT_BYTES)}).strict(), imageReferenceSchema])).min(1).max(32)]),
        tool_call_id: idSchema,
    }).strict(),
]);

export function hasCompleteToolPairs(messages: readonly Message[]): boolean {
    const pending = new Set<string>();
    const seen = new Set<string>();
    for (const message of messages) {
        if (message.role === "tool") {
            if (!pending.delete(message.tool_call_id)) return false;
            continue;
        }
        if (pending.size > 0) return false;
        if (message.role !== "assistant" || !message.tool_calls) continue;
        for (const call of message.tool_calls) {
            if (seen.has(call.id)) return false;
            seen.add(call.id);
            pending.add(call.id);
        }
    }
    return pending.size === 0;
}

const conversationSchema = z.array(messageSchema)
    .max(MAX_SESSION_MESSAGES)
    .refine(
        (messages) => byteLength(JSON.stringify(messages)) <=
            MAX_SESSION_CONVERSATION_BYTES
    )
    .refine((messages) => hasCompleteToolPairs(messages));

const todoSchema = z.object({
    content: boundedString(64 * 1024, false),
    status: z.enum(["pending", "in_progress", "completed"]),
    activeForm: boundedString(64 * 1024, false),
}).strict();

const diffLineSchema = z.object({
    type: z.enum(["context", "add", "remove"]),
    content: boundedString(1024 * 1024),
    oldLineNumber: nonNegativeIntegerSchema.optional(),
    newLineNumber: nonNegativeIntegerSchema.optional(),
}).strict();

const diffHunkSchema = z.object({
    oldStart: nonNegativeIntegerSchema,
    oldLines: nonNegativeIntegerSchema,
    newStart: nonNegativeIntegerSchema,
    newLines: nonNegativeIntegerSchema,
    lines: z.array(diffLineSchema).max(20_000),
}).strict();

const fileChangeSchema = z.object({
    version: z.literal(1),
    path: z.string().min(1).max(MAX_PATH_CHARS),
    kind: z.enum(["create", "update", "delete"]),
    scope: z.literal("turn").optional(),
    hunks: z.array(diffHunkSchema).max(4_096),
    linesAdded: nonNegativeIntegerSchema.nullable(),
    linesRemoved: nonNegativeIntegerSchema.nullable(),
    replacements: nonNegativeIntegerSchema.optional(),
    diffStatus: z.enum(["complete", "truncated", "unavailable"]),
    omittedDiffLines: nonNegativeIntegerSchema.optional(),
    diffUnavailableReason: z.enum(["timeout", "too_large", "binary", "error"]).optional(),
}).strict();

const persistedUIEventSchema = z.discriminatedUnion("type", [
    z.object({version: z.literal(1), type: z.literal("approval_review"), phase: z.literal("end"),
        requestId: idSchema, toolCallId: idSchema, turnId: idSchema, timestamp: timestampSchema,
        source: z.enum(["user", "auto-review", "preauthorized"]),
        outcome: z.enum(["allow", "deny", "needs_user", "error"]).optional(), reason: z.string().max(4000).optional(),
        code: z.enum(["policy_denied", "approval_required", "review_failed"]).optional(),
    }).strict(),
    z.object({
        version: z.literal(1),
        type: z.literal("tool_call"),
        turnId: idSchema,
        toolCallId: idSchema,
        timestamp: timestampSchema,
        outcome: z.enum(["ok", "failed", "denied", "interrupted"]),
    }).strict(),
    z.object({
        version: z.literal(1),
        type: z.literal("file_change"),
        turnId: idSchema,
        toolCallId: idSchema,
        timestamp: timestampSchema,
        change: fileChangeSchema,
    }).strict(),
]);

const compactStateSchema = z.object({
    consecutiveFailures: nonNegativeIntegerSchema,
    compactCount: nonNegativeIntegerSchema,
    lastCompactAt: timestampSchema.optional(),
    archives: z.array(archiveRecordSchema).max(128).refine(records =>
        new Set(records.map(record => record.id)).size === records.length &&
        records.reduce((sum, record) => sum + record.messages.length, 0) <= 100_000).optional(),
}).strict();

const contentBlockSchema = z.discriminatedUnion("kind", [
    z.object({kind: z.literal("message"), value: messageSchema}).strict(),
    z.object({kind: z.literal("ui"), value: persistedUIEventSchema}).strict(),
]);

export function decodeSessionContentBlock(value: unknown) {
    const parsed = contentBlockSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid Session content block");
    return parsed.data;
}

const sessionEntryBase = {
    version: z.literal(SESSION_ENTRY_VERSION),
    sessionId: idSchema,
    cwd: z.string().min(1).max(MAX_PATH_CHARS),
    model: z.string().min(1).max(MAX_MODEL_CHARS),
    timestamp: timestampSchema,
    conversation: conversationSchema,
    todos: z.array(todoSchema).max(MAX_TODOS),
    permissionMode: permissionModeSchema,
    collaborationMode: collaborationModeSchema,
    compactState: compactStateSchema.optional(),
    uiEvents: z.array(persistedUIEventSchema).max(MAX_UI_EVENTS),
    toolDiscovery: z.unknown().optional(),
};

const sessionSnapshotSchema = z.object({
    ...sessionEntryBase,
    type: z.literal("snapshot"),
    queuedInputs: z.unknown().optional(),
    taskNotificationReceipts: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(4096).refine(ids => new Set(ids).size === ids.length).optional(),
}).strict();

const sessionIndexEntrySchema = z.object({
    sessionId: idSchema,
    cwd: z.string().min(1).max(MAX_PATH_CHARS),
    model: z.string().min(1).max(MAX_MODEL_CHARS),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    messageCount: nonNegativeIntegerSchema,
    summary: z.string().max(MAX_SUMMARY_CHARS).optional(),
}).strict();

export function normalizeToolDiscoverySnapshot(
    value: unknown
): ToolDiscoverySnapshot | undefined {
    if (!value || typeof value !== "object") return undefined;
    const snapshot = value as Partial<ToolDiscoverySnapshot>;
    if (snapshot.version !== 2 || !Array.isArray(snapshot.loadedNames)) {
        return undefined;
    }
    const seen = new Set<string>();
    const loadedNames: string[] = [];
    for (const value of snapshot.loadedNames.slice(
        0,
        MAX_LOADED_DEFERRED_TOOLS
    )) {
        if (
            typeof value !== "string" ||
            value.length === 0 ||
            value.length > MAX_PERSISTED_TOOL_NAME_CHARS ||
            seen.has(value)
        ) continue;
        seen.add(value);
        loadedNames.push(value);
    }
    return {version: 2, loadedNames};
}

export function limitSessionUIEvents(
    events: readonly PersistedUIEvent[] | undefined
): PersistedUIEvent[] {
    return createSessionUIEventLimiter()(events);
}

export function createSessionUIEventLimiter() {
    const validated = new WeakMap<PersistedUIEvent, PersistedUIEvent>();
    const sizes = new WeakMap<PersistedUIEvent, number>();
    return (events: readonly PersistedUIEvent[] | undefined): PersistedUIEvent[] => {
        const valid = (events ?? []).flatMap(event => {
            const cached = Object.isFrozen(event) ? validated.get(event) : undefined;
            if (cached) return [cached];
            const parsed = persistedUIEventSchema.safeParse(event);
            if (!parsed.success) return [];
            if (Object.isFrozen(event)) validated.set(event, parsed.data);
            sizes.set(parsed.data, Buffer.byteLength(JSON.stringify(parsed.data)));
            return [parsed.data];
        });
        return limitPersistedUIEvents(valid, undefined, undefined, event => sizes.get(event)!);
    };
}

export function decodeSessionEntry(value: unknown): SessionEntry | undefined {
    const snapshot = sessionSnapshotSchema.safeParse(value);
    if (snapshot.success) {
        const queuedInputs = snapshot.data.queuedInputs === undefined
            ? undefined
            : normalizeRuntimeQueuedMessages(snapshot.data.queuedInputs);
        if (snapshot.data.queuedInputs !== undefined && !queuedInputs) {
            return undefined;
        }
        const toolDiscovery = snapshot.data.toolDiscovery === undefined
            ? undefined
            : normalizeToolDiscoverySnapshot(snapshot.data.toolDiscovery);
        return {
            ...snapshot.data,
            ...(queuedInputs === undefined ? {} : {queuedInputs}),
            ...(snapshot.data.taskNotificationReceipts ? {taskNotificationReceipts: snapshot.data.taskNotificationReceipts} : {}),
            ...(toolDiscovery === undefined ? {} : {toolDiscovery}),
        } as SessionSnapshotEntry;
    }

    return undefined;
}

export function decodeSessionIndexEntries(
    value: unknown,
    cwd: string
): SessionIndexEntry[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_SESSION_INDEX_ENTRIES) {
        return undefined;
    }
    const entries: SessionIndexEntry[] = [];
    const sessionIds = new Set<string>();
    const projectKey = getProjectKey(cwd);
    for (const candidate of value) {
        const parsed = sessionIndexEntrySchema.safeParse(candidate);
        if (
            !parsed.success ||
            getProjectKey(parsed.data.cwd) !== projectKey ||
            sessionIds.has(parsed.data.sessionId)
        ) return undefined;
        sessionIds.add(parsed.data.sessionId);
        entries.push(parsed.data);
    }
    return entries;
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
}

export function normalizeSessionSummaryHint(value: string): string {
    return truncate(normalizeText(value), MAX_SUMMARY_CHARS);
}

export function stripSystemMessage(history: Message[]): Message[] {
    return history.filter((message) => message.role !== "system");
}

function getUserText(message: Message): string | null {
    if (message.role !== "user" || message.origin !== "user") return null;
    return normalizeText(contentText(message.content));
}

function isMeaningfulUserText(text: string): boolean {
    return text.length > 0;
}

export function summarizeSessionHistory(history: Message[]): SessionHistorySummary {
    const prompts = history
        .map(getUserText)
        .filter((text): text is string => text !== null && isMeaningfulUserText(text));
    const prompt = prompts.at(-1);
    return {summary: prompt ? truncate(prompt, MAX_SUMMARY_CHARS) : undefined};
}

export function countSessionConversationMessages(history: Message[]): number {
    return history.filter((message) => {
        if (message.role === "system") return false;
        if (message.role === "user") {
            const text = getUserText(message);
            return text !== null && isMeaningfulUserText(text);
        }
        return true;
    }).length;
}
