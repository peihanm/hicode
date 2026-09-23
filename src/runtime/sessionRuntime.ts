import {ensureSessionIdentity} from "../persistence/projectState.js";
import {ContextUsageTracker} from "../context/usage.js";
import {ApprovalEpoch} from "../permissions/approval.js";
import type {MessageContent} from "../images/content.js";
import {createSessionArchiveAccess, prepareSessionArchive} from "../session/archive.js";
import {createSessionPersistence} from "../session/storage.js";
import {createFileStateTracker} from "../tools/shared/fileState.js";
import type {AgentEvent} from "../agent/types.js";
import type {CompactState} from "../context/index.js";
import type {PersistedUIEvent} from "../session/index.js";
import {createHookSessionRuntime, type HookBatchResult, type HookExecutionContext} from "../hooks/index.js";
import type {Message} from "../llm/types.js";
import {
    createDirectoryAccessRuntime,
    type DirectoryAccessRuntimeLike,
    type PermissionMode,
} from "../permissions/index.js";
import {appendLocalPermissionDirectory} from "../settings/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import {type SaveSessionSnapshotInput} from "../session/index.js";
import {createSubagentLauncher} from "../subagents/launcher.js";
import type {TaskSessionLike} from "../tasks/index.js";
import type {Todo} from "../todos.js";
import {createToolResultStore, type ToolResultStore} from "../toolResults/index.js";
import type {ToolDiscoverySnapshot} from "../tools/registry.js";
import type {ToolContext} from "../tools/types.js";
import type {RuntimeQueuedMessage} from "./messageQueue.js";
import {RuntimeMessageQueue} from "./messageQueue.js";
import type {RootRuntimeResources} from "./resources.js";
import {createToolContext, type ToolContextHost} from "./toolContext.js";
import {NetworkAccessSession} from "../permissions/networkAccess.js";
import {hasCompleteToolPairs} from "../session/codec.js";

export interface RootSessionSeed {
    sessionId: string;
    history: Message[];
    compactState: CompactState;
    toolDiscovery?: ToolDiscoverySnapshot;
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
    invalidateApprovals(): void;
    readonly sessionId: string;
    readonly history: Message[];
    readonly compactState: CompactState;
    readonly toolResultStore: ToolResultStore;
    readonly taskSession: TaskSessionLike;
    readonly messageQueue: RuntimeMessageQueue;
    readonly directoryAccess: DirectoryAccessRuntimeLike;

    initialize(): Promise<void>;

    replaceConversation(history: Message[], compactState: CompactState): void;

    createContext(input: {
        turnId?: string;
        signal: AbortSignal;
        host: ToolContextHost;
        onEvent: (event: AgentEvent) => void | Promise<void>;
        getSnapshotState(): RootSessionSnapshotState;
    }): ToolContext;

    createSnapshot(state: RootSessionSnapshotState): SaveSessionSnapshotInput;
    saveSnapshot(input: SaveSessionSnapshotInput): Promise<void>;
    flushSnapshots(): Promise<void>;
    takeStorageIssues(): string[];

    beginTurn(
        prompt: MessageContent,
        state: Omit<RootSessionSnapshotState, "allowEmpty" | "summaryHint">
    ): Promise<void>;

    endTurn(): void;

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
    allowBackgroundTasks = true,
}: {
    resources: RootRuntimeResources;
    seed: RootSessionSeed;
    allowBackgroundTasks?: boolean;
}): RootSessionRuntime {
    const fileState = createFileStateTracker();
    const approvalEpoch = new ApprovalEpoch();
    const contextUsage = new ContextUsageTracker();
    const persistence = createSessionPersistence(resources.storage, resources.cwd, seed.sessionId);
    let history = seed.history;
    let compactState = seed.compactState;
    const toolResultStore = createToolResultStore(
        resources.storage,
        resources.cwd,
        seed.sessionId
    );
    resources.toolRuntime.restoreToolDiscovery(seed.toolDiscovery);
    const messageQueue = new RuntimeMessageQueue({
        messages: seed.queuedInputs,
        taskReceipts: seed.taskNotificationReceipts,
    });
    const taskSession = resources.taskRuntime.forSession({
        sessionId: seed.sessionId, toolResultStore, allowBackgroundTasks, messageQueue,
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
    let turnActive = false;

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
        queuedInputs: messageQueue.list(),
        taskNotificationReceipts: messageQueue.getTaskReceipts(),
        toolDiscovery: resources.toolRuntime.getToolDiscoverySnapshot(),
        ...(state.allowEmpty ? {allowEmpty: true} : {}),
        ...(state.summaryHint ? {summaryHint: state.summaryHint} : {}),
    });

    return {
        invalidateApprovals: () => approvalEpoch.invalidate(),
        sessionId: seed.sessionId,
        get history() {
            return history;
        },
        get compactState() {
            return compactState;
        },
        toolResultStore,
        taskSession,
        messageQueue,
        directoryAccess,
        initialize() {
            initializePromise ??= (async () => {
                // Task Session restoration starts at construction. Drain every initializer even when another initializer fails.
                const results = await Promise.allSettled([
                    ensureSessionIdentity(resources.storage, resources.cwd, seed.sessionId),
                    taskSession.initialize(),
                    directoryAccess.initialize(),
                ] as const);
                for (const result of results) if (result.status === "rejected") throw result.reason;
            })();
            return initializePromise;
        },
        replaceConversation(nextHistory, nextCompactState) {
            contextUsage.reset();
            history = nextHistory;
            compactState = nextCompactState;
        },
        createContext({signal, host, onEvent, turnId, getSnapshotState}) {
            const ctx = createToolContext({
                signal, turnId,
                resources: {...resources, availableTools: resources.toolRuntime.getTools(), toolNames: resources.toolRuntime.toolNames, contextSettings: resources.settings.context, tasks: taskSession, agentMessaging: taskSession.messaging},
                session: {
                    approvalEpoch,
                    sessionId: seed.sessionId,
                    compactState,
                    contextUsage,
                    toolResultStore,
                    fileState,
                    allowBackgroundTasks,
                    hookSession,
                    directoryAccess,
                    networkAccess,
                },
                host,
            });
            ctx.sessionArchives = createSessionArchiveAccess(resources.storage, resources.cwd, seed.sessionId, () => compactState);
            ctx.approvalEvidence = () => history;
            ctx.reviewerModel = resources.settings.models.reviewer;
            ctx.onApprovalEvent = onEvent;
            ctx.memoryFiles = resources.memory.enabled ? resources.memory.fileAccess({sessionId: seed.sessionId, turnId: ctx.turnId, signal}) : undefined;
            ctx.sessionCompaction = {
                prepare: source => prepareSessionArchive(resources.storage, resources.cwd, seed.sessionId, source),
                async commit(candidate, nextState, draft) {
                    await persistence.compact({...snapshot(getSnapshotState()),
                        history: candidate, compactState: nextState}, draft, signal);
                },
            };
            ctx.commitToolBatch = async () => {
                if (!hasCompleteToolPairs(history)) throw new Error("Tool batch is not completely paired; refusing another model request");
                await persistence.save(snapshot(getSnapshotState()));
                await ctx.agentJoin?.acknowledgeReported();
            };
            ctx.toolHooks = {
                get enabled() {return resources.hooks.enabled;},
                hasToolHooks: name => resources.hooks.hasToolHooks(name),
                execute(input, signal, context) {
                    if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(input.hook_event_name)) {
                        throw new Error("Delegated Hook capability accepts tool events only");
                    }
                    return resources.hooks.execute(input, signal, context);
                },
            };
            ctx.holdHookConfiguration = resources.holdHookConfiguration;
            ctx.onHookEvent = onEvent;
            ctx.runHook = async (input, hookSignal = signal) => {
                const result = await resources.hooks.execute({...input, session_id: seed.sessionId, turn_id: ctx.turnId},
                    hookSignal, {session: hookSession, store: toolResultStore, onEvent});
                return result;
            };
            ctx.hookControl = {inspect: () => resources.hooks.inspect(), reload: async hookSignal => {
                if (turnActive) throw new Error("Cannot reload Hooks before the turn ends");
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
        saveSnapshot: persistence.save,
        flushSnapshots: persistence.drain,
        takeStorageIssues: persistence.takeIssues,
        async beginTurn(prompt, state) {
            await this.initialize();
            if (turnActive) throw new Error("This Session is already running");
            turnActive = true;
            try {
                await persistence.save({...snapshot(state),
                    history: [...history, {role: "user", origin: "user" as const, content: prompt}]});
            } catch (error) {turnActive = false; throw error;}
        },
        endTurn() {turnActive = false;},
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
