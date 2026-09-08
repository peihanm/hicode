import {contentText} from "../images/content.js";
import type {SessionArchiveDraft} from "./archive.js";
import {randomUUID} from "node:crypto";
import {createFileCheckpointStore} from "../checkpoints/store.js";
import {createInitialHistory} from "../prompt/index.js";
import {normalizeGitSessionState} from "../git/index.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {getProjectKey} from "../persistence/index.js";
import {
    countSessionConversationMessages,
    hasCompleteToolPairs,
    limitSessionUIEvents,
    normalizeSessionSummaryHint,
    normalizeToolDiscoverySnapshot,
    stripSystemMessage,
    summarizeSessionHistory,
} from "./codec.js";
import {readSessionIndex, upsertSessionIndex} from "./indexStore.js";
import {
    appendSessionEntry,
    replaceLatestSessionSnapshot,
    readLatestSessionSnapshot,
    readSessionEntries,
    readSessionCheckpointLinks,
    withSessionPersistenceLock,
    hasNewerSessionCompaction,
} from "./snapshotStore.js";
import {
    type LoadedSession,
    type SaveSessionSnapshotInput,
    type SaveSessionTurnCheckpointInput,
    SESSION_ENTRY_VERSION,
    type SessionIndexEntry,
    type SessionSnapshotEntry,
    type SessionTurnCheckpointEntry,
} from "./types.js";

export function createSessionId(): string {
    return randomUUID();
}

export async function saveSessionSnapshot(
    storage: PillarStorageLayout,
    input: SaveSessionSnapshotInput
): Promise<void> {
    return saveSnapshot(storage, input);
}

export function saveSessionCompaction(storage: PillarStorageLayout, input: SaveSessionSnapshotInput, draft: SessionArchiveDraft, signal: AbortSignal): Promise<void> {
    return saveSnapshot(storage, input, {draft, signal});
}

async function saveSnapshot(storage: PillarStorageLayout, input: SaveSessionSnapshotInput, compaction?: {draft: SessionArchiveDraft; signal: AbortSignal}): Promise<void> {
    const conversation = stripSystemMessage(input.history);
    // Todo/permission callbacks may request a snapshot while a tool batch is
    // still running. Keep the previous restorable state until results exist.
    if (!hasCompleteToolPairs(conversation)) {
        if (compaction) throw new Error("Refusing unpaired Session compaction");
        return;
    }
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
            input.compactState?.compactCount ?? 0, input.checkpointHead?.branchId)) return;
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
            uiEvents: limitSessionUIEvents(input.uiEvents),
            ...(input.checkpointHead
                ? {checkpointHead: {...input.checkpointHead}}
                : {}),
            ...(input.taskNotificationReceipts?.length ? {taskNotificationReceipts: [...input.taskNotificationReceipts]} : {}),
            ...(input.queuedInputs && input.queuedInputs.length > 0
                ? {queuedInputs: input.queuedInputs.map((message) => ({...message}))}
                : {}),
            ...(toolDiscovery ? {toolDiscovery} : {}),
            ...(gitSession ? {gitSession} : {}),
        };

        await replaceLatestSessionSnapshot(
            storage,
            input.cwd,
            input.sessionId,
            entry,
            await createFileCheckpointStore(storage, input.cwd, input.sessionId).getPendingRestore(),
            compaction
        );
        const updateProjections = async () => {
            await synchronizeCheckpointWindow(storage, input.cwd, input.sessionId);
            await upsertSessionIndex(storage, {
                cwd: input.cwd,
                sessionId: input.sessionId,
                model: input.model,
                timestamp,
                messageCount: countSessionConversationMessages(conversation),
                ...summary,
            });
        };
        // A committed compaction cannot be reported as failed because an index projection failed.
        if (compaction) await updateProjections().catch(() => undefined);
        else await updateProjections();
    });
}

export async function saveSessionTurnCheckpoint(
    storage: PillarStorageLayout,
    input: SaveSessionTurnCheckpointInput
): Promise<void> {
    const conversation = stripSystemMessage(input.history);
    const toolDiscovery = normalizeToolDiscoverySnapshot(input.toolDiscovery);
    const entry: SessionTurnCheckpointEntry = {
        type: "turn_checkpoint",
        version: SESSION_ENTRY_VERSION,
        checkpointId: input.checkpointId,
        sessionId: input.sessionId,
        branchId: input.branchId,
        ...(input.parentCheckpointId
            ? {parentCheckpointId: input.parentCheckpointId}
            : {}),
        cwd: input.cwd,
        model: input.model,
        timestamp: new Date().toISOString(),
        prompt: input.prompt,
        conversation,
        todos: [...input.todos],
        permissionMode: input.permissionMode,
        collaborationMode: input.collaborationMode,
        compactState: input.compactState ? {...input.compactState} : undefined,
        uiEvents: limitSessionUIEvents(input.uiEvents),
        ...(toolDiscovery ? {toolDiscovery} : {}),
    };
    await withSessionPersistenceLock(storage, input.cwd, async () => {
        await appendSessionEntry(storage, input.cwd, input.sessionId, entry);
        await synchronizeCheckpointWindow(storage, input.cwd, input.sessionId);
        const summary = summarizeSessionHistory(conversation);
        await upsertSessionIndex(storage, {
            cwd: input.cwd,
            sessionId: input.sessionId,
            model: input.model,
            timestamp: entry.timestamp,
            messageCount: countSessionConversationMessages(conversation),
            ...(summary.summary ? summary : {summary: normalizeSessionSummaryHint(contentText(input.prompt))}),
        });
    });
}

async function synchronizeCheckpointWindow(storage: PillarStorageLayout, cwd: string, sessionId: string): Promise<void> {
    await createFileCheckpointStore(storage, cwd, sessionId).retainSessionCheckpoints(
        readSessionCheckpointLinks(storage, cwd, sessionId).map(link => link.checkpointId)
    );
}

export function listSessionTurnCheckpoints(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string
): SessionTurnCheckpointEntry[] {
    return readSessionEntries(storage, cwd, sessionId)
        .filter(
            (entry): entry is SessionTurnCheckpointEntry =>
                entry.type === "turn_checkpoint" &&
                entry.version === SESSION_ENTRY_VERSION
        )
        .map((entry) => {
            const toolDiscovery = normalizeToolDiscoverySnapshot(
                entry.toolDiscovery
            );
            return {
                ...entry,
                ...(toolDiscovery ? {toolDiscovery} : {}),
            };
        });
}

export function loadSessionTurnCheckpoint(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string,
    checkpointId: string
): SessionTurnCheckpointEntry | null {
    return listSessionTurnCheckpoints(storage, cwd, sessionId)
        .findLast((entry) => entry.checkpointId === checkpointId) ?? null;
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
        checkpointHead: snapshot.checkpointHead
            ? {...snapshot.checkpointHead}
            : undefined,
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
