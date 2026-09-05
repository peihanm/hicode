import {createFileStateTracker} from "../tools/shared/fileState.js";
import type {AgentEvent} from "../agent/types.js";
import type {CompactState} from "../context/index.js";
import type {PersistedUIEvent} from "../session/index.js";
import {createHookSessionRuntime, didRunCommandHook, type HookBatchResult,} from "../hooks/index.js";
import type {Message} from "../llm/types.js";
import {
    createDirectoryAccessRuntime,
    type DirectoryAccessRuntimeLike,
    type PermissionMode,
} from "../permissions/index.js";
import {appendLocalPermissionDirectory} from "../settings/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import {type SaveSessionSnapshotInput, saveSessionTurnCheckpoint, listSessionTurnCheckpoints} from "../session/index.js";
import {createSubagentLauncher} from "../subagents/launcher.js";
import type {TaskSessionLike} from "../tasks/index.js";
import type {Todo} from "../todos.js";
import {createToolResultStore, type ToolResultStore} from "../toolResults/index.js";
import type {ToolDiscoverySnapshot} from "../tools/registry.js";
import type {ToolContext} from "../tools/types.js";
import {
    type CheckpointHead,
    createFileCheckpointRuntime,
    type FileCheckpointRuntimeLike,
} from "../checkpoints/index.js";
import {createGitSessionRuntime, type GitSessionRuntimeLike, type GitSessionState,} from "../git/index.js";
import type {RuntimeQueuedMessage} from "./messageQueue.js";
import {RuntimeMessageQueue} from "./messageQueue.js";
import type {RootRuntimeResources} from "./resources.js";
import {createToolContext, type ToolContextHost} from "./toolContext.js";
import {NetworkAccessSession} from "../permissions/networkAccess.js";

export interface RootSessionSeed {
    sessionId: string;
    history: Message[];
    compactState: CompactState;
    checkpointHead?: CheckpointHead;
    toolDiscovery?: ToolDiscoverySnapshot;
    gitSession?: GitSessionState;
    queuedInputs?: readonly RuntimeQueuedMessage[];
}

interface RootSessionSnapshotState {
    todos: readonly Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    uiEvents: readonly PersistedUIEvent[];
    allowEmpty?: boolean;
    summaryHint?: string;
}

const SESSION_END_TIMEOUT_MS = 1_500;

export interface RootSessionRuntime {
    readonly sessionId: string;
    readonly history: Message[];
    readonly compactState: CompactState;
    readonly toolResultStore: ToolResultStore;
    readonly fileCheckpoints: FileCheckpointRuntimeLike;
    readonly gitSession: GitSessionRuntimeLike;
    readonly taskSession: TaskSessionLike;
    readonly messageQueue: RuntimeMessageQueue;
    readonly directoryAccess: DirectoryAccessRuntimeLike;

    initialize(): Promise<void>;

    replaceConversation(history: Message[], compactState: CompactState): void;

    createContext(input: {
        signal: AbortSignal;
        host: ToolContextHost;
        onEvent: (event: AgentEvent) => void | Promise<void>;
    }): ToolContext;

    createSnapshot(state: RootSessionSnapshotState): SaveSessionSnapshotInput;

    beginCheckpoint(
        prompt: string,
        state: Omit<RootSessionSnapshotState, "allowEmpty" | "summaryHint">
    ): Promise<void>;

    settleCheckpoint(status?: "settled" | "no_agent_run"): Promise<void>;

    runSessionStart(
        source: "startup" | "resume",
        signal: AbortSignal
    ): Promise<HookBatchResult>;

    runUserPromptHooks(
        prompt: string,
        permissionMode: PermissionMode,
        signal: AbortSignal
    ): Promise<HookBatchResult>;

    runSessionEnd(reason: string): Promise<HookBatchResult>;
}

export function createRootSessionRuntime({
    resources,
    seed,
    resumed,
    allowBackgroundTasks = true,
}: {
    resources: RootRuntimeResources;
    seed: RootSessionSeed;
    resumed: boolean;
    allowBackgroundTasks?: boolean;
}): RootSessionRuntime {
    const fileState = createFileStateTracker();
    let history = seed.history;
    let compactState = seed.compactState;
    const toolResultStore = createToolResultStore(
        resources.storage,
        resources.cwd,
        seed.sessionId
    );
    resources.toolRuntime.restoreToolDiscovery(seed.toolDiscovery);
    const gitSession = createGitSessionRuntime({
        cwd: resources.cwd,
        workspace: resources.gitWorkspace,
        persistedState: seed.gitSession,
        resumed,
    });
    const fileCheckpoints = createFileCheckpointRuntime({
        storage: resources.storage,
        cwd: resources.cwd,
        hardBoundary: resources.workspaceBoundary,
        sessionId: seed.sessionId,
        enabled: resources.settings.checkpointing.enabled,
        fileState,
        initialHead: seed.checkpointHead,
    });
    const taskSession = resources.taskRuntime.forSession({
        sessionId: seed.sessionId,
        toolResultStore,
        allowBackgroundTasks,
    });
    const messageQueue = new RuntimeMessageQueue({
        messages: seed.queuedInputs,
    });
    const hookSession = createHookSessionRuntime();
    const networkAccess = new NetworkAccessSession();
    const directoryAccess = createDirectoryAccessRuntime({
        cwd: resources.cwd,
        hardBoundary: resources.workspaceBoundary,
        initialDirectories: resources.settings.permissions.additionalDirectories,
        persistDirectory: (directory) =>
            appendLocalPermissionDirectory(resources.cwd, directory),
    });
    let initializePromise: Promise<void> | undefined;
    let checkpointStartFailed = false;

    const snapshot = (
        state: RootSessionSnapshotState
    ): SaveSessionSnapshotInput => ({
        cwd: resources.cwd,
        model: resources.model,
        sessionId: seed.sessionId,
        history: [...history],
        todos: [...state.todos],
        permissionMode: state.permissionMode,
        collaborationMode: state.collaborationMode,
        compactState: {...compactState},
        uiEvents: [...state.uiEvents],
        checkpointHead: fileCheckpoints.getHead(),
        queuedInputs: messageQueue.list(),
        toolDiscovery: resources.toolRuntime.getToolDiscoverySnapshot(),
        gitSession: gitSession.getState(),
        ...(state.allowEmpty ? {allowEmpty: true} : {}),
        ...(state.summaryHint ? {summaryHint: state.summaryHint} : {}),
    });

    return {
        sessionId: seed.sessionId,
        get history() {
            return history;
        },
        get compactState() {
            return compactState;
        },
        toolResultStore,
        fileCheckpoints,
        gitSession,
        taskSession,
        messageQueue,
        directoryAccess,
        initialize() {
            initializePromise ??= (async () => {
                // Task Session restoration starts at construction. Drain every initializer even when head reconciliation fails.
                const results = await Promise.allSettled([
                    Promise.resolve().then(() => fileCheckpoints.reconcileSession(seed.checkpointHead,
                        listSessionTurnCheckpoints(resources.storage, resources.cwd, seed.sessionId))),
                    gitSession.initialize(),
                    taskSession.initialize(),
                    directoryAccess.initialize(),
                ] as const);
                for (const result of results) if (result.status === "rejected") throw result.reason;
                const recovery = results[0];
                if (recovery.status !== "fulfilled") throw recovery.reason;
                const interrupted = recovery.value;
                if (interrupted.length) {
                    const details = interrupted.map(record => {
                        const paths = record.mutations.slice(0, 20).map(mutation => mutation.path.slice(0, 512));
                        return `${record.checkpointId}: ${record.promptPreview}; 已记录 ${record.mutations.length} 个文件变更，路径示例 ${JSON.stringify(paths)}`;
                    });
                    history.push({role: "user", content: `<system-reminder>\nSession 崩溃恢复：以下 Turn 的最终对话未完整保存，已按 interrupted 保留文件 Checkpoint lineage。文件不会自动撤销；不要假定任务完成，请重新读取涉及文件并核验。\n${details.join("\n")}\n</system-reminder>`});
                }
            })();
            return initializePromise;
        },
        replaceConversation(nextHistory, nextCompactState) {
            history = nextHistory;
            compactState = nextCompactState;
        },
        createContext({signal, host, onEvent}) {
            const ctx = createToolContext({
                signal,
                resources: {...resources, gitSession, tasks: taskSession},
                session: {
                    sessionId: seed.sessionId,
                    compactState,
                    toolResultStore,
                    fileCheckpoints,
                    fileState,
                    allowBackgroundTasks,
                    hookSession,
                    directoryAccess,
                    networkAccess,
                },
                host,
            });
            const runSubagent = resources.agentRuntime.createSubagentRunner({
                parentContext: ctx,
                onEvent,
            });
            ctx.subagentLauncher = createSubagentLauncher({
                parentContext: ctx,
                getHistory: () => history,
                runSubagent,
            });
            return ctx;
        },
        createSnapshot: snapshot,
        async beginCheckpoint(prompt, state) {
            await this.initialize();
            if (checkpointStartFailed) throw new Error("Checkpoint 启动未完整提交，必须重新恢复 Session");
            try {
                const checkpoint = await fileCheckpoints.beginTurn({prompt});
                if (!checkpoint) return;
                await saveSessionTurnCheckpoint(resources.storage, {
                    cwd: resources.cwd,
                    model: resources.model,
                    sessionId: seed.sessionId,
                    checkpointId: checkpoint.checkpointId,
                    branchId: checkpoint.branchId,
                    parentCheckpointId: checkpoint.parentCheckpointId,
                    prompt,
                    history,
                    todos: [...state.todos],
                    permissionMode: state.permissionMode,
                    collaborationMode: state.collaborationMode,
                    compactState,
                    uiEvents: [...state.uiEvents],
                    toolDiscovery:
                        resources.toolRuntime.getToolDiscoverySnapshot(),
                });
            } catch (error) {
                checkpointStartFailed = true;
                throw error;
            }
        },
        settleCheckpoint(status = "settled") {
            return fileCheckpoints.settleTurn(status);
        },
        runSessionStart(source, signal) {
            return resources.hooks.execute({
                hook_event_name: "SessionStart",
                session_id: seed.sessionId,
                source,
                model: resources.model,
            }, signal, {session: hookSession});
        },
        async runUserPromptHooks(prompt, permissionMode, signal) {
            const result = await resources.hooks.execute({
                hook_event_name: "UserPromptSubmit",
                session_id: seed.sessionId,
                permission_mode: permissionMode,
                prompt,
            }, signal, {session: hookSession});
            if (didRunCommandHook(result)) {
                await fileCheckpoints.markCoverageWarning({
                    code: "hook_side_effects",
                    message: "UserPromptSubmit Hook 可能产生未被 File Checkpoint 捕获的文件副作用",
                });
            }
            return result;
        },
        async runSessionEnd(reason) {
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort("session-end-timeout"),
                SESSION_END_TIMEOUT_MS
            );
            timer.unref?.();
            try {
                return await resources.hooks.execute({
                    hook_event_name: "SessionEnd",
                    session_id: seed.sessionId,
                    reason,
                }, controller.signal, {session: hookSession});
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
