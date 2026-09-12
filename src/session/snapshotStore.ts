import {dirname} from "node:path";
import {
    ensurePrivateStorageDirectory, getProjectKey, readPrivateStorageTextFile,
    type PillarStorageLayout, withFileLock, writeFileAtomically,
} from "../persistence/index.js";
import {decodeSessionEntry, hasCompleteToolPairs} from "./codec.js";
import {ensureSessionsDirectory, getSessionLogPath, getSessionPersistenceLockPath} from "./paths.js";
import {SessionContentStore, isSessionContentId, MAX_SESSION_CONTENT_BYTES} from "./contentStore.js";
import type {SessionEntry, SessionSnapshotEntry} from "./types.js";
import {collectArchiveViews, readArchiveMessages, type SessionArchiveDraft} from "./archive.js";
import {throwIfTurnAborted} from "../runtime/abort.js";

const MAX_SESSION_LOG_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_ENTRY_BYTES = 72 * 1024 * 1024;
type StoredEntry = Omit<SessionSnapshotEntry, "conversation" | "uiEvents"> & {conversation: string[]; uiEvents: string[]};

export function withSessionPersistenceLock<T>(storage: PillarStorageLayout, cwd: string, action: () => Promise<T>): Promise<T> {
    ensureSessionsDirectory(storage, cwd);
    return withFileLock(getSessionPersistenceLockPath(storage, cwd), action);
}

function references(entries: readonly StoredEntry[]): Set<string> {
    return new Set(entries.flatMap(entry => [...entry.conversation, ...entry.uiEvents,
        ...(entry.compactState?.archives ?? []).flatMap(record => record.messages)]));
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
            if (hasSnapshot) throw new Error("Duplicate Session snapshot");
            hasSnapshot = true;
            entries.push(entry);
        } catch (error) { throw new Error(`Cannot update invalid session log: ${path}`, {cause: error}); }
    }
    return entries;
}

function hydrate(entry: StoredEntry, blocks: SessionContentStore): SessionEntry {
    for (const archive of entry.compactState?.archives ?? []) readArchiveMessages(archive, blocks);
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

/** Called under the project persistence lock; one Session owns this committer. */
export function createSessionSnapshotCommitter(storage: PillarStorageLayout, cwd: string, sessionId: string) {
    const blocks = new SessionContentStore(storage, cwd, sessionId);
    let lastCommit: string | undefined;
    return async (entry: SessionEntry, compaction: {draft: SessionArchiveDraft; signal: AbortSignal} | undefined, preserveConversation: boolean): Promise<boolean> => {
        const normalized = decodeSessionEntry({...entry, conversation: [], uiEvents: []});
        if (!normalized || !hasCompleteToolPairs(entry.conversation) || entry.conversation.length > 20_000 || entry.uiEvents.length > 4_096) throw new Error("Refusing to persist invalid or oversized session entry");
        const previous = readReferences(storage, cwd, sessionId);
        const prior = previous.at(-1);
        if (preserveConversation && !prior) return false;
        if (preserveConversation) normalized.compactState = prior!.compactState;
        const previousKey = JSON.stringify(previous);
        if (lastCommit !== undefined && previousKey !== lastCommit) throw new Error("Session snapshot changed outside its writer");
        if (lastCommit === undefined) for (const old of previous) hydrate(old, blocks);
        else blocks.verifyStored(references(previous));
        const oldRefs = references(previous);
        if (compaction) {
            const prior = previous.findLast(item => item.type === "snapshot");
            const archives = normalized.compactState?.archives ?? [];
            if (archives.at(-1)?.id !== compaction.draft.record.id ||
                JSON.stringify(archives.slice(0, -1)) !== JSON.stringify(prior?.compactState?.archives ?? [])) {
                throw new Error("Session archive base changed before compaction commit");
            }
            for (const value of compaction.draft.messages) blocks.stage({kind: "message", value});
        }
        const knownArchives = new Set(previous.flatMap(old => (old.compactState?.archives ?? []).map(archive => JSON.stringify(archive))));
        for (const archive of normalized.compactState?.archives ?? []) {
            if (!knownArchives.has(JSON.stringify(archive))) readArchiveMessages(archive, blocks);
        }
        const stored: StoredEntry = {...normalized,
            conversation: preserveConversation ? prior!.conversation : entry.conversation.map(value => {
                if (value.role === "system") throw new Error("Session cannot persist system messages");
                return blocks.stage({kind: "message", value});
            }),
            uiEvents: preserveConversation ? prior!.uiEvents : entry.uiEvents.map(value => blocks.stage({kind: "ui", value})),
        };
        const conversationBytes = blocks.arrayBytes(stored.conversation);
        const uiBytes = blocks.arrayBytes(stored.uiEvents);
        if (conversationBytes > 64 * 1024 * 1024 || uiBytes > 20 * 1024 * 1024 ||
            conversationBytes + uiBytes + Buffer.byteLength(JSON.stringify(normalized)) - 4 > MAX_SESSION_ENTRY_BYTES) throw new Error("Invalid Session conversation or UI budget");
        const entries = [stored];
        const content = JSON.stringify(stored) + "\n";
        const ids = references(entries);
        if (Buffer.byteLength(content) > MAX_SESSION_LOG_BYTES || blocks.bytes(ids) + Buffer.byteLength(content) > MAX_SESSION_CONTENT_BYTES || ids.size > 131_072) {
            throw new Error("Session current state exceeds storage budget");
        }
        const path = getSessionLogPath(storage, cwd, sessionId);
        ensurePrivateStorageDirectory(storage, dirname(path));
        await blocks.collect(new Set([...oldRefs, ...ids]));
        await blocks.persist(ids);
        if (compaction) throwIfTurnAborted(compaction.signal);
        await writeFileAtomically(path, content, 0o600);
        lastCommit = JSON.stringify(entries);
        blocks.releaseBodies(ids);
        // Reference commit is the truth; failed reclamation must not invalidate an already committed snapshot.
        await blocks.collect(ids).catch(() => undefined);
        if ([...previous, ...entries].some(item => item.compactState?.archives?.length)) {
            await collectArchiveViews(storage, cwd, sessionId, new Set(entries.flatMap(item =>
                item.compactState?.archives?.map(record => record.id) ?? []))).catch(() => undefined);
        }
        return true;
    };
}

export function hasNewerSessionCompaction(storage: PillarStorageLayout, cwd: string, sessionId: string, count: number): boolean {
    const previous = readReferences(storage, cwd, sessionId).findLast(entry => entry.type === "snapshot");
    return (previous?.compactState?.compactCount ?? 0) > count;
}

export function readLatestSessionSnapshot(storage: PillarStorageLayout, cwd: string, sessionId: string): SessionSnapshotEntry | null {
    try {
        const entry = readReferences(storage, cwd, sessionId).findLast(entry => entry.type === "snapshot");
        if (!entry) return null;
        const result = hydrate(entry, new SessionContentStore(storage, cwd, sessionId));
        return result.type === "snapshot" ? result : null;
    } catch { return null; }
}

export function readSessionSourceIds(storage: PillarStorageLayout, cwd: string, sessionId: string): string[] {
    const entry = readReferences(storage, cwd, sessionId).findLast(entry => entry.type === "snapshot");
    return entry ? [...new Set([...(entry.compactState?.archives ?? []).flatMap(archive => archive.messages), ...entry.conversation])] : [];
}

export function readSessionSourceMessages(storage: PillarStorageLayout, cwd: string, sessionId: string, hashes: readonly string[]) {
    if (!hashes.length || hashes.length > 64 || hashes.some(hash => !isSessionContentId(hash))) throw new Error("Invalid Memory source count or hash");
    const allowed = new Set(readSessionSourceIds(storage, cwd, sessionId));
    if (hashes.some(hash => !allowed.has(hash))) throw new Error("Memory source is outside the current Session");
    const blocks = new SessionContentStore(storage, cwd, sessionId);
    const result = hashes.map(hash => {
        const block = blocks.read(hash);
        if (block.kind !== "message") throw new Error("Memory source is not a message");
        const value = block.value;
        return value.role === "user"
            ? {id: hash, role: value.role, origin: value.origin, content: value.content}
            : {id: hash, role: value.role, content: value.content};
    });
    if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024) throw new Error("Memory source exceeds 32 KiB and was not sent to the model");
    return result;
}

/** Select complete message bodies; skipped bytes are a declared coverage gap, never a guessed fact. */
export function selectSessionMemorySource(storage:PillarStorageLayout,cwd:string,sessionId:string,baseline:readonly string[]) {
    const seen=new Set(baseline);
    const fresh=readSessionSourceIds(storage,cwd,sessionId).filter(id=>!seen.has(id));
    const candidates=[...new Set([...fresh.slice(0,1),...fresh.slice(-63)])];
    const blocks=new SessionContentStore(storage,cwd,sessionId);
    const selected:string[]=[];let bytes=2;
    for(const id of candidates.toReversed()){
        const block=blocks.read(id);
        if(block.kind!=="message")throw new Error("Memory source is not a message");
        const message=block.value;
        if(!message.content||(message.role==="user"&&(message.origin==="compaction"||message.origin==="runtime")))continue;
        const cost=Buffer.byteLength(JSON.stringify({id,role:message.role,...(message.role==="user"?{origin:message.origin}:{}),content:message.content}))+1;
        if(bytes+cost>32*1024)continue;
        selected.push(id);bytes+=cost;
    }
    selected.reverse();
    return {hashes:selected,omitted:fresh.length-selected.length};
}
