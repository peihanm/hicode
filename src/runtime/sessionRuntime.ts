import {forkSessionConversation} from "../session/fork.js";
import {createSessionArchiveAccess, prepareSessionArchive} from "../session/archive.js";
import {saveSessionCompaction} from "../session/storage.js";
import {restoreSessionCheckpointWithRuntime} from "../checkpoints/rewind.js";
import type {CheckpointRestoreResult} from "../checkpoints/types.js";
import {loadSession} from "../session/index.js";
import {createFileStateTracker} from "../tools/shared/fileState.js";
import type {AgentEvent} from "../agent/types.js";
import type {CompactState} from "../context/index.js";
import type {PersistedUIEvent} from "../session/index.js";
import {createHookSessionRuntime, didRunCommandHook, type HookBatchResult, type HookExecutionContext} from "../hooks/index.js";
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
    taskNotificationReceipts?: readonly string[];
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

    restoreCheckpoint(checkpointId: string, permissionMode?: PermissionMode): Promise<CheckpointRestoreResult>;

    forkConversation(checkpointId: string, permissionMode: PermissionMode): Promise<{sessionId: string}>;

    replaceConversation(history: Message[], compactState: CompactState): void;

    createContext(input: {
        turnId?: string;
        signal: AbortSignal;
        host: ToolContextHost;
        onEvent: (event: AgentEvent) => void | Promise<void>;
        getSnapshotState(): RootSessionSnapshotState;
    }): ToolContext;

    createSnapshot(state: RootSessionSnapshotState): SaveSessionSnapshotInput;

    beginCheckpoint(
        prompt: string,
        state: Omit<RootSessionSnapshotState, "allowEmpty" | "summaryHint">
    ): Promise<void>;

    settleCheckpoint(status?: "settled" | "no_agent_run"): Promise<void>;

    runSessionStart(
        source: "startup" | "resume",
        signal: AbortSignal,
        onEvent?: HookExecutionContext["onEvent"]
    ): Promise<HookBatchResult>;

    runSessionEnd(reason: string, onEvent?: HookExecutionContext["onEvent"]): Promise<HookBatchResult>;
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
        taskReceipts: seed.taskNotificationReceipts,
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
    let turnActive = false;
    let restoring = false;

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
        taskNotificationReceipts: messageQueue.getTaskReceipts(),
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
        async forkConversation(checkpointId, permissionMode) {
            if (turnActive || restoring) throw new Error("请等待当前 Turn 或恢复完成");
            return forkSessionConversation({storage: resources.storage, cwd: resources.cwd, model: resources.model,
                sessionId: seed.sessionId, checkpointId, permissionMode});
        },
        async restoreCheckpoint(checkpointId, permissionMode) {
            if (turnActive || restoring || resources.taskRuntime.hasRunningThatBlocksRewind()) throw new Error("仍有活动 Turn 或工作区任务，不能恢复");
            restoring = true;
            try {
                return await resources.fileCommits.exclusive(new AbortController().signal, async () => {
                    const result = await restoreSessionCheckpointWithRuntime({storage: resources.storage, cwd: resources.cwd,
                        model: resources.model, sessionId: seed.sessionId, checkpointId, permissionMode, runtime: fileCheckpoints, gitSession});
                    if (result.status === "complete") {
                        const loaded = loadSession(resources.storage, resources.cwd, seed.sessionId, resources.model);
                        if (!loaded) throw new Error("恢复后的 Session 不可读取");
                        history = loaded.history;
                        compactState = loaded.compactState ?? compactState;
                        resources.toolRuntime.restoreToolDiscovery(loaded.toolDiscovery);
                    }
                    return result;
                });
            } finally {restoring = false;}
        },
        replaceConversation(nextHistory, nextCompactState) {
            history = nextHistory;
            compactState = nextCompactState;
        },
        createContext({signal, host, onEvent, turnId, getSnapshotState}) {
            const ctx = createToolContext({
                signal, turnId,
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
            ctx.sessionArchives = createSessionArchiveAccess(resources.storage, resources.cwd, seed.sessionId, () => compactState);
            ctx.memoryFiles = resources.memory.enabled ? resources.memory.fileAccess({sessionId: seed.sessionId, turnId: ctx.turnId, signal}) : undefined;
            ctx.sessionCompaction = {
                prepare: source => prepareSessionArchive(resources.storage, resources.cwd, seed.sessionId, source),
                async commit(candidate, nextState, draft) {
                    await saveSessionCompaction(resources.storage, {...snapshot(getSnapshotState()),
                        history: candidate, compactState: nextState}, draft, signal);
                },
            };
            ctx.holdHookConfiguration = resources.holdHookConfiguration;
            ctx.onHookEvent = onEvent;
            ctx.runHook = async (input, hookSignal = signal) => {
                const result = await resources.hooks.execute({...input, session_id: seed.sessionId, turn_id: ctx.turnId},
                    hookSignal, {session: hookSession, store: toolResultStore, onEvent});
                if (turnActive && didRunCommandHook(result)) await fileCheckpoints.markCoverageWarning({
                    code: "hook_side_effects", message: `${input.hook_event_name} Command Hook 可能产生未被 File Checkpoint 捕获的文件副作用`,
                });
                return result;
            };
            ctx.hookControl = {inspect: () => resources.hooks.inspect(), reload: async hookSignal => {
                if (turnActive) throw new Error("本轮尚未结束，不能重载 Hooks");
                await resources.reloadHooks(hookSignal);
            }};
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
            if (restoring || turnActive) throw new Error("当前 Session 已在运行或恢复中");
            if (checkpointStartFailed) throw new Error("Checkpoint 启动未完整提交，必须重新恢复 Session");
            turnActive = true;
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
                turnActive = false;
                checkpointStartFailed = true;
                throw error;
            }
        },
        async settleCheckpoint(status = "settled") {
            try {await fileCheckpoints.settleTurn(status);} finally {turnActive = false;}
        },
        runSessionStart(source, signal, onEvent) {
            return resources.hooks.execute({
                hook_event_name: "SessionStart",
                session_id: seed.sessionId,
                source,
                model: resources.model,
            }, signal, {session: hookSession, store: toolResultStore, onEvent});
        },
        async runSessionEnd(reason, onEvent) {
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
                }, controller.signal, {session: hookSession, store: toolResultStore, onEvent});
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
