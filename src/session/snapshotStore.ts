import {dirname} from "node:path";
import {
    ensurePrivateStorageDirectory, getProjectKey, readPrivateStorageTextFile,
    type PillarStorageLayout, withFileLock, writeFileAtomically,
} from "../persistence/index.js";
import {decodeSessionEntry, hasCompleteToolPairs} from "./codec.js";
import {ensureSessionsDirectory, getSessionLogPath, getSessionPersistenceLockPath} from "./paths.js";
import {SessionContentStore, isSessionContentId, MAX_SESSION_CONTENT_BYTES} from "./contentStore.js";
import type {SessionEntry, SessionSnapshotEntry, SessionTurnCheckpointEntry} from "./types.js";

const MAX_SESSION_LOG_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_ENTRY_BYTES = 72 * 1024 * 1024;
const MAX_SESSION_TURN_CHECKPOINTS = 100;
type StoredEntry = (Omit<SessionSnapshotEntry, "conversation" | "uiEvents"> |
    Omit<SessionTurnCheckpointEntry, "conversation" | "uiEvents">) & {conversation: string[]; uiEvents: string[]};

export function withSessionPersistenceLock<T>(storage: PillarStorageLayout, cwd: string, action: () => Promise<T>): Promise<T> {
    ensureSessionsDirectory(storage, cwd);
    return withFileLock(getSessionPersistenceLockPath(storage, cwd), action);
}

function references(entries: readonly StoredEntry[]): Set<string> {
    return new Set(entries.flatMap(entry => [...entry.conversation, ...entry.uiEvents]));
}

function decodeReferenceEntry(value: unknown): StoredEntry {
    if (!value || typeof value !== "object" || !("conversation" in value) || !("uiEvents" in value) ||
        !Array.isArray(value.conversation) || value.conversation.length > 20_000 || !value.conversation.every(isSessionContentId) ||
        !Array.isArray(value.uiEvents) || value.uiEvents.length > 4_096 || !value.uiEvents.every(isSessionContentId)) {
        throw new Error("Invalid Session content references");
    }
    const metadata = decodeSessionEntry({...value, conversation: [], uiEvents: []});
    if (!metadata) throw new Error("Invalid Session metadata");
    return {...metadata, conversation: value.conversation, uiEvents: value.uiEvents};
}

function readReferences(storage: PillarStorageLayout, cwd: string, sessionId: string): StoredEntry[] {
    const path = getSessionLogPath(storage, cwd, sessionId);
    const content = readPrivateStorageTextFile(storage, path, MAX_SESSION_LOG_BYTES);
    if (content === null) return [];
    const lines = content.split("\n");
    if (lines.length > 4_096) throw new Error(`Session log entry limit exceeded: ${path}`);
    const entries: StoredEntry[] = [];
    const checkpointIds = new Set<string>();
    let hasSnapshot = false;
    for (let n = 0; n < lines.length; n++) {
        const line = lines[n]!;
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); }
        catch (error) {
            if (n === lines.length - 1 && !content.endsWith("\n")) break;
            throw new Error(`Cannot update corrupt session log: ${path}`, {cause: error});
        }
        try {
            const entry = decodeReferenceEntry(value);
            if (entry.sessionId !== sessionId || getProjectKey(entry.cwd) !== getProjectKey(cwd)) throw new Error("Session owner mismatch");
            if (entry.type === "snapshot") {
                if (hasSnapshot) throw new Error("Duplicate Session snapshot");
                hasSnapshot = true;
            } else {
                if (checkpointIds.has(entry.checkpointId)) throw new Error("Duplicate Session checkpoint");
                checkpointIds.add(entry.checkpointId);
            }
            entries.push(entry);
        } catch (error) { throw new Error(`Cannot update invalid session log: ${path}`, {cause: error}); }
    }
    return entries;
}

function hydrate(entry: StoredEntry, blocks: SessionContentStore): SessionEntry {
    const conversation = entry.conversation.map(id => {
        const block = blocks.read(id);
        if (block.kind !== "message") throw new Error("Session message reference has wrong kind");
        return block.value;
    });
    const uiEvents = entry.uiEvents.map(id => {
        const block = blocks.read(id);
        if (block.kind !== "ui") throw new Error("Session UI reference has wrong kind");
        return block.value;
    });
    // Blocks have already passed their schemas once. Check the aggregate invariants without reserializing all retained histories.
    const conversationBytes = blocks.arrayBytes(entry.conversation);
    const uiBytes = blocks.arrayBytes(entry.uiEvents);
    const metadataBytes = Buffer.byteLength(JSON.stringify({...entry, conversation: [], uiEvents: []}));
    if (!hasCompleteToolPairs(conversation) || conversationBytes > 64 * 1024 * 1024 || uiBytes > 20 * 1024 * 1024 ||
        conversationBytes + uiBytes + metadataBytes - 4 > MAX_SESSION_ENTRY_BYTES) throw new Error("Invalid Session conversation or UI budget");
    return {...entry, conversation, uiEvents};
}

async function commitEntry(storage: PillarStorageLayout, cwd: string, sessionId: string, entry: SessionEntry): Promise<void> {
    const normalized = decodeSessionEntry(entry);
    if (!normalized || Buffer.byteLength(JSON.stringify(normalized)) > MAX_SESSION_ENTRY_BYTES) throw new Error("Refusing to persist invalid or oversized session entry");
    const blocks = new SessionContentStore(storage, cwd, sessionId);
    const previous = readReferences(storage, cwd, sessionId);
    for (const old of previous) hydrate(old, blocks);
    const oldRefs = references(previous);
    const stored: StoredEntry = {...normalized,
        conversation: normalized.conversation.map(value => {
            if (value.role === "system") throw new Error("Session cannot persist system messages");
            return blocks.stage({kind: "message", value});
        }),
        uiEvents: normalized.uiEvents.map(value => blocks.stage({kind: "ui", value})),
    };
    let entries: StoredEntry[];
    if (stored.type === "snapshot") {
        entries = [...previous.filter(old => old.type === "turn_checkpoint"), stored];
    } else {
        const prior = previous.findLast(entry => entry.type === "snapshot");
        const {checkpointId: _id, branchId, parentCheckpointId, prompt: _prompt, ...state} = stored;
        // Persist the pre-turn state even for the first Turn. Its head remains the parent until settlement.
        const snapshot: StoredEntry = {...state, type: "snapshot",
            checkpointHead: {branchId, ...(parentCheckpointId ? {checkpointId: parentCheckpointId} : {})},
            ...(prior?.type === "snapshot" && prior.queuedInputs ? {queuedInputs: prior.queuedInputs} : {}),
            ...(prior?.type === "snapshot" && prior.gitSession ? {gitSession: prior.gitSession} : {}),
        };
        entries = [...previous.filter(old => old.type === "turn_checkpoint"), stored, snapshot];
    }
    // Keep the newest snapshot and a contiguous suffix of rewind points under both budgets.
    const latestSnapshot = entries.findLast(entry => entry.type === "snapshot");
    entries = entries.filter(entry => entry.type !== "snapshot" || entry === latestSnapshot);
    let content: string;
    let ids: Set<string>;
    while (true) {
        content = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
        ids = references(entries);
        const bytes = blocks.bytes(ids) + Buffer.byteLength(content);
        if (entries.filter(entry => entry.type === "turn_checkpoint").length <= MAX_SESSION_TURN_CHECKPOINTS &&
            Buffer.byteLength(content) <= MAX_SESSION_LOG_BYTES && bytes <= MAX_SESSION_CONTENT_BYTES && ids.size <= 131_072) break;
        const oldest = entries.findIndex(entry => entry.type === "turn_checkpoint" && entry !== stored);
        if (oldest < 0) throw new Error("Session current state exceeds storage budget");
        entries.splice(oldest, 1);
    }
    const path = getSessionLogPath(storage, cwd, sessionId);
    ensurePrivateStorageDirectory(storage, dirname(path));
    await blocks.collect(oldRefs);
    await blocks.persist(ids);
    await writeFileAtomically(path, content, 0o600);
    // Reference commit is the truth; failed reclamation must not invalidate an already committed snapshot.
    await blocks.collect(ids).catch(() => undefined);
}

/** Caller holds the project Session persistence lock. */
export function appendSessionEntry(storage: PillarStorageLayout, cwd: string, sessionId: string, entry: SessionEntry): Promise<void> {
    return commitEntry(storage, cwd, sessionId, entry);
}

export function replaceLatestSessionSnapshot(storage: PillarStorageLayout, cwd: string, sessionId: string, entry: SessionSnapshotEntry): Promise<void> {
    return commitEntry(storage, cwd, sessionId, entry);
}

export function readSessionEntries(storage: PillarStorageLayout, cwd: string, sessionId: string): SessionEntry[] {
    const blocks = new SessionContentStore(storage, cwd, sessionId);
    return readReferences(storage, cwd, sessionId).map(entry => hydrate(entry, blocks));
}

export function readLatestSessionSnapshot(storage: PillarStorageLayout, cwd: string, sessionId: string): SessionSnapshotEntry | null {
    try {
        const entry = readReferences(storage, cwd, sessionId).findLast(entry => entry.type === "snapshot");
        if (!entry) return null;
        const result = hydrate(entry, new SessionContentStore(storage, cwd, sessionId));
        return result.type === "snapshot" ? result : null;
    } catch { return null; }
}

export function readSessionCheckpointLinks(storage: PillarStorageLayout, cwd: string, sessionId: string) {
    return readReferences(storage, cwd, sessionId).flatMap(entry => entry.type === "turn_checkpoint"
        ? [{checkpointId: entry.checkpointId, branchId: entry.branchId, parentCheckpointId: entry.parentCheckpointId}]
        : []);
}
