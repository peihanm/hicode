import {randomUUID} from "node:crypto";
import {createInitialHistory} from "../prompt/index.js";
import {normalizeGitSessionState} from "../git/index.js";
import {
    countSessionConversationMessages,
    isRuntimeQueuedMessage,
    limitSessionUIEvents,
    normalizeSessionSummaryHint,
    normalizeToolDiscoverySnapshot,
    stripSystemMessage,
    summarizeSessionHistory,
} from "./codec.js";
import {readSessionIndex, upsertSessionIndex} from "./indexStore.js";
import {
    appendSessionEntry,
    readLatestSessionSnapshot,
    readSessionEntries,
    withSessionPersistenceLock,
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
    input: SaveSessionSnapshotInput
): Promise<void> {
    const conversation = stripSystemMessage(input.history);
    const summarized = summarizeSessionHistory(conversation);
    const hint = input.summaryHint
        ? normalizeSessionSummaryHint(input.summaryHint)
        : undefined;
    const summary = summarized.summary
        ? summarized
        : {firstPrompt: hint, lastPrompt: hint, summary: hint};
    if (!summary.summary && !input.allowEmpty) return;

    await withSessionPersistenceLock(input.cwd, async () => {
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
            prePlanMode: input.prePlanMode,
            compactState: input.compactState,
            uiEvents: limitSessionUIEvents(input.uiEvents),
            ...(input.checkpointHead
                ? {checkpointHead: {...input.checkpointHead}}
                : {}),
            ...(input.queuedInputs && input.queuedInputs.length > 0
                ? {queuedInputs: input.queuedInputs.map((message) => ({...message}))}
                : {}),
            ...(toolDiscovery ? {toolDiscovery} : {}),
            ...(gitSession ? {gitSession} : {}),
        };

        await appendSessionEntry(input.cwd, input.sessionId, entry);
        await upsertSessionIndex({
            cwd: input.cwd,
            sessionId: input.sessionId,
            model: input.model,
            timestamp,
            messageCount: countSessionConversationMessages(conversation),
            ...summary,
        });
    });
}

export async function saveSessionTurnCheckpoint(
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
        prePlanMode: input.prePlanMode,
        compactState: input.compactState ? {...input.compactState} : undefined,
        uiEvents: limitSessionUIEvents(input.uiEvents),
        ...(toolDiscovery ? {toolDiscovery} : {}),
    };
    await withSessionPersistenceLock(input.cwd, () =>
        appendSessionEntry(input.cwd, input.sessionId, entry)
    );
}

export function listSessionTurnCheckpoints(
    cwd: string,
    sessionId: string
): SessionTurnCheckpointEntry[] {
    return readSessionEntries(cwd, sessionId)
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
    cwd: string,
    sessionId: string,
    checkpointId: string
): SessionTurnCheckpointEntry | null {
    return listSessionTurnCheckpoints(cwd, sessionId)
        .findLast((entry) => entry.checkpointId === checkpointId) ?? null;
}

export function listSessionIndex(cwd: string): SessionIndexEntry[] {
    return readSessionIndex(cwd).sessions
        .filter((entry) => entry.cwd === cwd && !entry.archived)
        .flatMap((entry) => {
            const snapshot = readLatestSessionSnapshot(cwd, entry.sessionId);
            return snapshot
                ? [{
                    ...entry,
                    messageCount: countSessionConversationMessages(
                        snapshot.conversation
                    ),
                }]
                : [];
        })
        .sort(
            (left, right) =>
                new Date(right.updatedAt).getTime() -
                new Date(left.updatedAt).getTime()
        );
}

export function loadSession(
    cwd: string,
    sessionId: string,
    model: string
): LoadedSession | null {
    const snapshot = readLatestSessionSnapshot(cwd, sessionId);
    if (!snapshot) return null;
    const index = readSessionIndex(cwd).sessions.find(
        (entry) => entry.sessionId === sessionId
    );
    return {
        sessionId,
        cwd: snapshot.cwd,
        model: snapshot.model,
        history: [...createInitialHistory(cwd, model), ...snapshot.conversation],
        todos: snapshot.todos,
        permissionMode: snapshot.permissionMode,
        prePlanMode: snapshot.prePlanMode,
        compactState: snapshot.compactState,
        uiEvents: limitSessionUIEvents(snapshot.uiEvents),
        checkpointHead: snapshot.checkpointHead
            ? {...snapshot.checkpointHead}
            : undefined,
        queuedInputs: Array.isArray(snapshot.queuedInputs)
            ? snapshot.queuedInputs.filter(isRuntimeQueuedMessage)
            : [],
        toolDiscovery: normalizeToolDiscoverySnapshot(snapshot.toolDiscovery),
        gitSession: normalizeGitSessionState(snapshot.gitSession),
        index,
    };
}

export function loadLatestSession(
    cwd: string,
    model: string
): LoadedSession | null {
    const latest = listSessionIndex(cwd)[0];
    return latest ? loadSession(cwd, latest.sessionId, model) : null;
}
