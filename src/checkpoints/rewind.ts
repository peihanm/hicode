import type {PermissionMode} from "../permissions/index.js";
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
import {createGitSessionRuntime, createGitWorkspaceRuntime, type GitSessionState, type GitSessionRuntimeLike,} from "../git/index.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {FileCommitCoordinator} from "./fileCommit.js";
import type {RootRuntimeResources} from "../runtime/resources.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";

function requireTurnCheckpoint(
    storage: PillarStorageLayout,
    cwd: string,
    sessionId: string,
    checkpointId: string
): SessionTurnCheckpointEntry {
    const checkpoint = loadSessionTurnCheckpoint(
        storage,
        cwd,
        sessionId,
        checkpointId
    );
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
    storage: PillarStorageLayout;
    cwd: string;
    model: string;
    sessionId: string;
    checkpoint: SessionTurnCheckpointEntry;
    permissionMode: PermissionMode;
    runtime: FileCheckpointRuntimeLike;
    gitSession?: GitSessionState;
}): Promise<void> {
    await saveSessionSnapshot(input.storage, {
        cwd: input.cwd,
        model: input.model,
        sessionId: input.sessionId,
        history: checkpointHistory(input.cwd, input.model, input.checkpoint),
        todos: input.checkpoint.todos,
        permissionMode: input.permissionMode,
        collaborationMode: input.checkpoint.collaborationMode,
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
    storage: PillarStorageLayout;
    cwd: string;
    hardBoundary: string;
    model: string;
    sessionId: string;
    checkpointId: string;
    childEnvironment: ChildProcessEnvironment;
}): Promise<CheckpointRestoreResult> {
    const loaded = loadSession(
        input.storage,
        input.cwd,
        input.sessionId,
        input.model
    );
    if (!loaded) throw new Error(`没有找到会话: ${input.sessionId}`);
    const runtime = createFileCheckpointRuntime({
        storage: input.storage,
        cwd: input.cwd,
        hardBoundary: input.hardBoundary,
        sessionId: input.sessionId,
        enabled: false,
        initialHead: loaded.checkpointHead,
    });
    const gitSession = createGitSessionRuntime({
        cwd: input.cwd,
        workspace: createGitWorkspaceRuntime(input.cwd, input.childEnvironment),
        persistedState: loaded.gitSession,
        resumed: true,
    });
    await gitSession.initialize();

    return new FileCommitCoordinator().exclusive(new AbortController().signal, () => restoreSessionCheckpointWithRuntime({...input, runtime, gitSession}));
}

export async function restoreSessionCheckpointWithRuntime(input: {
    storage: PillarStorageLayout; cwd: string; model: string; sessionId: string; checkpointId: string;
    runtime: FileCheckpointRuntimeLike; gitSession: GitSessionRuntimeLike; permissionMode?: PermissionMode;
}): Promise<CheckpointRestoreResult> {
    // Load all conversation references before touching workspace files.
    const checkpoint = requireTurnCheckpoint(input.storage, input.cwd, input.sessionId, input.checkpointId);
    const current = loadSession(input.storage, input.cwd, input.sessionId, input.model);
    if (!current) throw new Error("恢复缺少原 Session");
    const permissionMode = input.permissionMode ?? current.permissionMode;
    const codeResult = await input.runtime.restoreCode(input.checkpointId);
    if (codeResult.restoredFiles.length) input.gitSession.observePaths(codeResult.restoredFiles, input.cwd);
    if (codeResult.status !== "complete") return codeResult;
    try {
        await saveConversationState({...input, checkpoint, permissionMode, gitSession: input.gitSession.getState()});
        await input.runtime.completeRestore(input.checkpointId);
        return codeResult;
    } catch (error) {
        return {...codeResult, status: "partial", failures: [{path: "<conversation>", message: error instanceof Error ? error.message : String(error)}]};
    }
}

/** Composition entries run recovery before building any Session/UI state from a saved snapshot. */
export async function recoverSessionBeforeStart(resources: RootRuntimeResources, sessionId: string) {
    const runtime = createFileCheckpointRuntime({storage: resources.storage, cwd: resources.cwd,
        hardBoundary: resources.workspaceBoundary, sessionId, enabled: false});
    const checkpointId = await runtime.getPendingRestore();
    if (!checkpointId) return undefined;
    if (resources.taskRuntime.hasRunningThatBlocksRewind()) throw new Error("仍有工作区任务运行，不能继续未完成的恢复");
    const loaded = loadSession(resources.storage, resources.cwd, sessionId, resources.model);
    if (!loaded) throw new Error("未完成恢复缺少原 Session");
    const gitSession = createGitSessionRuntime({cwd: resources.cwd, workspace: resources.gitWorkspace, persistedState: loaded.gitSession, resumed: true});
    await gitSession.initialize();
    const result = await resources.fileCommits.exclusive(new AbortController().signal, () => restoreSessionCheckpointWithRuntime({
        storage: resources.storage, cwd: resources.cwd, model: resources.model, sessionId, checkpointId, runtime, gitSession,
    }));
    if (result.status !== "complete") throw new Error(`未完成恢复仍有冲突或保存故障：${JSON.stringify(result.conflicts.length ? result.conflicts : result.failures)}`);
    const restored = loadSession(resources.storage, resources.cwd, sessionId, resources.model);
    if (!restored) throw new Error("恢复后 Session 不可读取");
    return restored;
}
