import type {SessionArchiveDraft} from "./archive.js";
import {randomUUID} from "node:crypto";
import {createInitialHistory} from "../prompt/index.js";
import {normalizeGitSessionState} from "../git/index.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {getProjectKey} from "../persistence/index.js";
import {
    countSessionConversationMessages,
    hasCompleteToolPairs,
    limitSessionUIEvents,
    createSessionUIEventLimiter,
    normalizeSessionSummaryHint,
    normalizeToolDiscoverySnapshot,
    stripSystemMessage,
    summarizeSessionHistory,
} from "./codec.js";
import {readSessionIndex, upsertSessionIndex} from "./indexStore.js";
import {
    createSessionSnapshotCommitter,
    readLatestSessionSnapshot,
    withSessionPersistenceLock,
    hasNewerSessionCompaction,
} from "./snapshotStore.js";
import {
    type LoadedSession,
    type SaveSessionSnapshotInput,
    SESSION_ENTRY_VERSION,
    type SessionIndexEntry,
    type SessionSnapshotEntry,
} from "./types.js";
import {createSessionValueFreezer} from "./contentStore.js";

/** Serial persistence belongs to the Session, shared by tools, compaction and every Host. */
export function createSessionPersistence(storage: PillarStorageLayout, cwd: string, sessionId: string) {
    const commit = createSessionSnapshotCommitter(storage, cwd, sessionId);
    const limitUIEvents = createSessionUIEventLimiter();
    const freezeSessionValue = createSessionValueFreezer();
    let pending = Promise.resolve();
    const enqueue = (input: SaveSessionSnapshotInput, compaction?: {draft: SessionArchiveDraft; signal: AbortSignal}) => {
        if (input.cwd !== cwd || input.sessionId !== sessionId) return Promise.reject(new Error("Session writer owner mismatch"));
        const preserveConversation = !hasCompleteToolPairs(stripSystemMessage(input.history));
        if (preserveConversation && compaction) return Promise.reject(new Error("Refusing unpaired Session compaction"));
        const snapshot: SaveSessionSnapshotInput = {
            ...structuredClone({...input, history: [], uiEvents: []}),
            history: preserveConversation ? [] : input.history.map(message => freezeSessionValue(message)),
            uiEvents: preserveConversation ? [] : input.uiEvents?.map(event => freezeSessionValue(event)),
            ...(preserveConversation ? {summaryHint: summarizeSessionHistory(input.history).summary ?? input.summaryHint} : {}),
        };
        const operation = pending.then(() => saveSnapshot(storage, snapshot, commit, limitUIEvents, preserveConversation, compaction));
        pending = operation.catch(() => undefined);
        return operation;
    };
    return {
        save: (input: SaveSessionSnapshotInput) => enqueue(input),
        compact: (input: SaveSessionSnapshotInput, draft: SessionArchiveDraft, signal: AbortSignal) => enqueue(input, {draft, signal}),
        drain: () => pending,
    };
}

export function createSessionId(): string {
    return randomUUID();
}

async function saveSnapshot(storage: PillarStorageLayout, input: SaveSessionSnapshotInput,
    commit: ReturnType<typeof createSessionSnapshotCommitter>, limitUIEvents: ReturnType<typeof createSessionUIEventLimiter>,
    preserveConversation: boolean, compaction?: {draft: SessionArchiveDraft; signal: AbortSignal}): Promise<void> {
    const conversation = stripSystemMessage(input.history);
    const summarized = summarizeSessionHistory(conversation);
    const hint = input.summaryHint
        ? normalizeSessionSummaryHint(input.summaryHint)
        : undefined;
    const summary = summarized.summary
        ? summarized
        : {firstPrompt: hint, lastPrompt: hint, summary: hint};
    if (!summary.summary && !input.allowEmpty && !compaction) return;

    await withSessionPersistenceLock(storage, input.cwd, async () => {
        // A queued pre-compaction UI snapshot must not undo a committed archive/History.
        if (!compaction && hasNewerSessionCompaction(storage, input.cwd, input.sessionId,
            input.compactState?.compactCount ?? 0)) return;
        const timestamp = new Date().toISOString();
        const toolDiscovery = normalizeToolDiscoverySnapshot(input.toolDiscovery);
        const gitSession = normalizeGitSessionState(input.gitSession);
        const entry: SessionSnapshotEntry = {
            type: "snapshot",
            version: SESSION_ENTRY_VERSION,
            sessionId: input.sessionId,
            cwd: input.cwd,
            model: input.model,
            timestamp,
            conversation,
            todos: input.todos,
            permissionMode: input.permissionMode,
            collaborationMode: input.collaborationMode,
            compactState: input.compactState,
            uiEvents: limitUIEvents(input.uiEvents),
            ...(input.taskNotificationReceipts?.length ? {taskNotificationReceipts: [...input.taskNotificationReceipts]} : {}),
            ...(input.queuedInputs && input.queuedInputs.length > 0
                ? {queuedInputs: input.queuedInputs.map((message) => ({...message}))}
                : {}),
            ...(toolDiscovery ? {toolDiscovery} : {}),
            ...(gitSession ? {gitSession} : {}),
        };

        if (!await commit(entry, compaction, preserveConversation)) return;
        const priorIndex = preserveConversation ? readSessionIndex(storage, input.cwd).sessions.find(item => item.sessionId === input.sessionId) : undefined;
        const updateProjections = async () => {
            await upsertSessionIndex(storage, {
                cwd: input.cwd,
                sessionId: input.sessionId,
                model: input.model,
                timestamp,
                messageCount: preserveConversation ? priorIndex?.messageCount ?? 0 : countSessionConversationMessages(conversation),
                ...summary,
            });
        };
        // A committed compaction cannot be reported as failed because an index projection failed.
        if (compaction) await updateProjections().catch(() => undefined);
        else await updateProjections();
    });
}

export function listSessionIndex(
    storage: PillarStorageLayout,
    cwd: string
): SessionIndexEntry[] {
    const projectKey = getProjectKey(cwd);
    return readSessionIndex(storage, cwd).sessions
        .filter(
            (entry) => getProjectKey(entry.cwd) === projectKey && !entry.archived
        )
        .sort(
            (left, right) =>
                new Date(right.updatedAt).getTime() -
                new Date(left.updatedAt).getTime()
        );
}

export function loadSession(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string,
    model: string
): LoadedSession | null {
    const snapshot = readLatestSessionSnapshot(storage, cwd, sessionId);
    if (!snapshot) return null;
    const index = readSessionIndex(storage, cwd).sessions.find(
        (entry) => entry.sessionId === sessionId
    );
    return {
        sessionId,
        cwd,
        model: snapshot.model,
        history: [...createInitialHistory(cwd, model), ...snapshot.conversation],
        todos: snapshot.todos,
        permissionMode: snapshot.permissionMode,
        collaborationMode: snapshot.collaborationMode,
        compactState: snapshot.compactState,
        uiEvents: limitSessionUIEvents(snapshot.uiEvents),
        queuedInputs: snapshot.queuedInputs ?? [],
        taskNotificationReceipts: snapshot.taskNotificationReceipts ?? [],
        toolDiscovery: normalizeToolDiscoverySnapshot(snapshot.toolDiscovery),
        gitSession: normalizeGitSessionState(snapshot.gitSession),
        index,
    };
}

export function loadLatestSession(
    storage: PillarStorageLayout,
    cwd: string,
    model: string
): LoadedSession | null {
    const latest = listSessionIndex(storage, cwd)[0];
    return latest ? loadSession(storage, cwd, latest.sessionId, model) : null;
}
