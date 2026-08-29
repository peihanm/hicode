import {createCompactState} from "../context/index.js";
import {createInitialHistory} from "../prompt/index.js";
import {
    loadSession,
    loadSessionTurnCheckpoint,
    saveSessionSnapshot,
    type SessionTurnCheckpointEntry,
} from "../session/index.js";
import {createFileCheckpointRuntime} from "./runtime.js";
import type {CheckpointRestoreResult, FileCheckpointRuntimeLike,} from "./types.js";
import {createGitSessionRuntime, createGitWorkspaceRuntime, type GitSessionState,} from "../git/index.js";

function requireTurnCheckpoint(
    cwd: string,
    sessionId: string,
    checkpointId: string
): SessionTurnCheckpointEntry {
    const checkpoint = loadSessionTurnCheckpoint(cwd, sessionId, checkpointId);
    if (!checkpoint) {
        throw new Error(`找不到对话 Checkpoint: ${checkpointId}`);
    }
    return checkpoint;
}

function checkpointHistory(
    cwd: string,
    model: string,
    checkpoint: SessionTurnCheckpointEntry
) {
    return [
        ...createInitialHistory(cwd, model),
        ...checkpoint.conversation,
    ];
}

async function saveConversationState(input: {
    cwd: string;
    model: string;
    sessionId: string;
    checkpoint: SessionTurnCheckpointEntry;
    runtime: FileCheckpointRuntimeLike;
    gitSession?: GitSessionState;
}): Promise<void> {
    await saveSessionSnapshot({
        cwd: input.cwd,
        model: input.model,
        sessionId: input.sessionId,
        history: checkpointHistory(input.cwd, input.model, input.checkpoint),
        todos: input.checkpoint.todos,
        permissionMode: input.checkpoint.permissionMode,
        prePlanMode: input.checkpoint.prePlanMode,
        compactState: input.checkpoint.compactState ?? createCompactState(),
        uiEvents: input.checkpoint.uiEvents,
        toolDiscovery: input.checkpoint.toolDiscovery,
        checkpointHead: input.runtime.getHead(),
        gitSession: input.gitSession,
        allowEmpty: true,
        summaryHint: input.checkpoint.prompt,
    });
}

export async function rewindSessionCheckpoint(input: {
    cwd: string;
    model: string;
    sessionId: string;
    checkpointId: string;
}): Promise<CheckpointRestoreResult> {
    const loaded = loadSession(input.cwd, input.sessionId, input.model);
    if (!loaded) throw new Error(`没有找到会话: ${input.sessionId}`);
    const runtime = createFileCheckpointRuntime({
        cwd: input.cwd,
        sessionId: input.sessionId,
        enabled: false,
        initialHead: loaded.checkpointHead,
    });
    const gitSession = createGitSessionRuntime({
        cwd: input.cwd,
        workspace: createGitWorkspaceRuntime(input.cwd),
        persistedState: loaded.gitSession,
        resumed: true,
    });
    await gitSession.initialize();

    const checkpoint = requireTurnCheckpoint(
        input.cwd,
        input.sessionId,
        input.checkpointId
    );

    const codeResult = await runtime.restoreCode(input.checkpointId);
    if (codeResult.restoredFiles.length > 0) {
        gitSession.observePaths(codeResult.restoredFiles, input.cwd);
    }
    if (codeResult.status !== "complete") {
        return codeResult;
    }

    try {
        await saveConversationState({
            cwd: input.cwd,
            model: input.model,
            sessionId: input.sessionId,
            checkpoint,
            runtime,
            gitSession: gitSession.getState(),
        });
        return codeResult;
    } catch (error) {
        return {
            ...codeResult,
            status: "partial",
            failures: [{
                path: "<conversation>",
                message: error instanceof Error ? error.message : String(error),
            }],
        };
    }
}
