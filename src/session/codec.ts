import {limitPersistedUIEvents, type PersistedUIEvent,} from "./uiEvents.js";
import type {Message} from "../llm/types.js";
import {isPermissionMode} from "../permissions/index.js";
import type {RuntimeQueuedMessage} from "../runtime/messageQueue.js";
import type {ToolDiscoverySnapshot} from "../tools/registry.js";
import {SESSION_ENTRY_VERSION, type SessionSnapshotEntry, type SessionTurnCheckpointEntry,} from "./types.js";

const MAX_PERSISTED_DISCOVERED_TOOLS = 4_096;
const MAX_PERSISTED_TOOL_NAME_CHARS = 256;

export interface SessionHistorySummary {
    firstPrompt?: string;
    lastPrompt?: string;
    summary?: string;
}

export function normalizeToolDiscoverySnapshot(
    value: unknown
): ToolDiscoverySnapshot | undefined {
    if (!value || typeof value !== "object") return undefined;
    const snapshot = value as Partial<ToolDiscoverySnapshot>;
    if (snapshot.version !== 1 || !Array.isArray(snapshot.discoveredNames)) {
        return undefined;
    }
    const seen = new Set<string>();
    const discoveredNames: string[] = [];
    for (const value of snapshot.discoveredNames.slice(
        0,
        MAX_PERSISTED_DISCOVERED_TOOLS
    )) {
        if (
            typeof value !== "string" ||
            value.length === 0 ||
            value.length > MAX_PERSISTED_TOOL_NAME_CHARS ||
            seen.has(value)
        ) continue;
        seen.add(value);
        discoveredNames.push(value);
    }
    discoveredNames.sort((left, right) => left.localeCompare(right, "en-US"));
    return {version: 1, discoveredNames};
}

function isPersistedUIEvent(value: unknown): value is PersistedUIEvent {
    if (!value || typeof value !== "object") return false;
    const event = value as Partial<PersistedUIEvent>;
    if (
        event.version !== 1 ||
        typeof event.turnId !== "string" ||
        typeof event.toolCallId !== "string" ||
        typeof event.timestamp !== "string"
    ) return false;
    if (event.type === "tool_call") {
        return event.outcome === "ok" ||
            event.outcome === "failed" ||
            event.outcome === "denied" ||
            event.outcome === "interrupted";
    }
    return event.type === "file_change" &&
        Boolean(event.change) &&
        typeof event.change?.path === "string" &&
        event.change.version === 1 &&
        Array.isArray(event.change.hunks) &&
        (event.change.linesAdded === null ||
            typeof event.change.linesAdded === "number") &&
        (event.change.linesRemoved === null ||
            typeof event.change.linesRemoved === "number");
}

export function limitSessionUIEvents(
    events: readonly PersistedUIEvent[] | undefined
): PersistedUIEvent[] {
    return limitPersistedUIEvents((events ?? []).filter(isPersistedUIEvent));
}

export function isSessionSnapshotEntry(
    value: unknown
): value is SessionSnapshotEntry {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<SessionSnapshotEntry>;
    return entry.type === "snapshot" &&
        entry.version === SESSION_ENTRY_VERSION &&
        typeof entry.sessionId === "string" &&
        typeof entry.cwd === "string" &&
        typeof entry.model === "string" &&
        typeof entry.timestamp === "string" &&
        Array.isArray(entry.conversation) &&
        Array.isArray(entry.todos) &&
        isPermissionMode(entry.permissionMode) &&
        Array.isArray(entry.uiEvents);
}

export function isSessionTurnCheckpointEntry(
    value: unknown
): value is SessionTurnCheckpointEntry {
    if (!value || typeof value !== "object") return false;
    const entry = value as Partial<SessionTurnCheckpointEntry>;
    return entry.type === "turn_checkpoint" &&
        entry.version === SESSION_ENTRY_VERSION &&
        typeof entry.checkpointId === "string" &&
        typeof entry.sessionId === "string" &&
        typeof entry.branchId === "string" &&
        typeof entry.cwd === "string" &&
        typeof entry.model === "string" &&
        typeof entry.timestamp === "string" &&
        typeof entry.prompt === "string" &&
        Array.isArray(entry.conversation) &&
        Array.isArray(entry.todos) &&
        isPermissionMode(entry.permissionMode) &&
        Array.isArray(entry.uiEvents);
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
}

export function normalizeSessionSummaryHint(value: string): string {
    return truncate(normalizeText(value), 120);
}

export function stripSystemMessage(history: Message[]): Message[] {
    return history.filter((message) => message.role !== "system");
}

function getUserText(message: Message): string | null {
    if (message.role !== "user") return null;
    return normalizeText(message.content);
}

function isMeaningfulUserText(text: string): boolean {
    return text.length > 0 &&
        !text.startsWith("<system-reminder>") &&
        !text.startsWith("[为了重试压缩");
}

export function summarizeSessionHistory(history: Message[]): SessionHistorySummary {
    const prompts = history
        .map(getUserText)
        .filter((text): text is string => text !== null && isMeaningfulUserText(text));
    const firstPrompt = prompts[0] ? truncate(prompts[0], 120) : undefined;
    const lastPrompt = prompts[prompts.length - 1]
        ? truncate(prompts[prompts.length - 1]!, 120)
        : undefined;
    return {
        firstPrompt,
        lastPrompt,
        summary: lastPrompt ?? firstPrompt,
    };
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

export function isRuntimeQueuedMessage(
    value: unknown
): value is RuntimeQueuedMessage {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    return typeof message.id === "string" &&
        (message.type === "user_input" || message.type === "task_notification") &&
        (message.priority === "next" ||
            message.priority === "later") &&
        typeof message.content === "string" &&
        typeof message.createdAt === "string" &&
        (message.type === "user_input"
            ? message.taskId === undefined
            : typeof message.taskId === "string" && message.taskId.length > 0);
}
