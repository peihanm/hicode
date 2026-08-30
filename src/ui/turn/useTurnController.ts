import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,} from "react";
import {updateInitialHistoryModel} from "../../prompt/index.js";
import {createSlashCommandProcessor} from "../../slash/index.js";
import {
    type LoadedSession,
    saveSessionSnapshot,
    type SaveSessionSnapshotInput,
} from "../../session/index.js";
import type {PermissionDecision} from "../../permissions/index.js";
import {addToAllowList, type PermissionMode, type PermissionRules,} from "../../permissions/index.js";
import type {RootRuntimeResources} from "../../runtime/resources.js";
import type {Todo} from "../../todos.js";
import type {UIThread} from "../conversation/types.js";
import type {ConfirmReq} from "./types.js";
import {UITurnController} from "./controller.js";
import {UITurnEventStore} from "./eventStore.js";
import {UIPermissionRequests} from "./permissionRequests.js";
import {SessionSnapshotQueue} from "./sessionQueue.js";
import {estimateRestoredTokenInfo} from "./tokenInfo.js";
import {formatAgentLoadWarning} from "../../subagents/diagnostics.js";
import {formatHookContext, getHookExecutionIssues, type HookBatchResult,} from "../../hooks/index.js";
import type {RootSessionRuntime} from "../../runtime/sessionRuntime.js";
import type {ModelTargetSettings} from "../../settings/types.js";
import {formatModelTarget} from "../../llm/modelCatalog.js";
import {createUICheckpointActions} from "./checkpointActions.js";

export interface UseTurnControllerOptions {
    resources: RootRuntimeResources;
    initialPermissionMode?: PermissionMode;
    initialSession?: LoadedSession;
    rootSession: RootSessionRuntime;
    resumedDraft?: string;
    openRewind?: () => void;
    openAgents?: () => void;
    openGitDiff?: () => void;
    openModel?: () => void;
}

/**
 * 只把仍需动态更新的线程交给 Ink live 区。
 *
 * 文件 diff 会在同一 iteration 内持续合并；如果合并期间也把完整 diff
 * 渲染到 live 区，长 diff 可能已经进入终端滚动历史，随后转入 Static 时
 * 就会看起来像重复输出。它们因此只在 iteration/turn 固化后展示一次。
 */
export function selectLiveThreads(
    threads: UIThread[],
    staticThreads: UIThread[]
): UIThread[] {
    const staticThreadIds = new Set(staticThreads.map((thread) => thread.id));
    return threads.filter(
        (thread) =>
            !staticThreadIds.has(thread.id) && thread.role !== "file_change_group"
    );
}

export function useTurnController({
                                          resources,
                                          initialPermissionMode,
                                          initialSession,
                                          rootSession,
                                          resumedDraft,
                                          openRewind,
                                          openAgents,
                                          openGitDiff,
                                          openModel,
                                      }: UseTurnControllerOptions) {
        const {cwd, model, toolRuntime} = resources;
        const runAgentImpl = resources.agentRuntime.runAgent;
        const messageQueue = rootSession.messageQueue;
        const taskSession = rootSession.taskSession;
        const sessionInitializationRef = useRef<Promise<void> | null>(null);
        const [sessionInitializationError, setSessionInitializationError] =
            useState<string>();
        const initializeSession = useCallback(() => {
            sessionInitializationRef.current ??= rootSession.initialize();
            return sessionInitializationRef.current;
        }, [rootSession]);

        const permissionRulesRef = useRef<PermissionRules | null>(null);
        if (permissionRulesRef.current === null) {
            permissionRulesRef.current = resources.settings.permissions.rules;
        }

        const [permissionMode, setPermissionModeState] = useState<PermissionMode>(
            () =>
                initialPermissionMode ??
                initialSession?.permissionMode ??
                resources.settings.permissions.defaultMode
        );
        const [primaryModel, setPrimaryModelState] = useState<ModelTargetSettings>(
            () => resources.primaryModel.target
        );
        const permissionModeRef = useRef<PermissionMode>(permissionMode);
        const prePlanModeRef = useRef<PermissionMode | undefined>(
            permissionMode === "plan" ? initialSession?.prePlanMode : undefined
        );
        const [todos, setTodosState] = useState<Todo[]>(
            () => initialSession?.todos ?? []
        );
        const todosRef = useRef<Todo[]>(todos);
        const [inputReplacement, setInputReplacement] = useState<{
            value: string;
            revision: number;
            appendCurrent?: boolean;
        } | undefined>(() => resumedDraft
            ? {value: resumedDraft, revision: 1}
            : undefined);

        const eventStoreRef = useRef<UITurnEventStore | null>(null);
        if (eventStoreRef.current === null) {
            const store = new UITurnEventStore({
                history: initialSession?.history,
                uiEvents: initialSession?.uiEvents,
                initialTokenInfo: initialSession
                    ? estimateRestoredTokenInfo(
                        initialSession.history,
                        resources.skills,
                        resources.instructions,
                        toolRuntime.getToolSchemas(),
                        model
                    )
                    : undefined,
            });
            const agentWarning = formatAgentLoadWarning(resources.subagents.issues);
            if (agentWarning) store.appendWarning(agentWarning);
            for (const issue of resources.hooks.issues) {
                store.appendWarning(issue.message);
            }
            eventStoreRef.current = store;
        }
        const eventStore = eventStoreRef.current;

        const sessionHookControllerRef = useRef<AbortController | null>(null);
        if (sessionHookControllerRef.current === null) {
            sessionHookControllerRef.current = new AbortController();
        }
        const sessionStartPromiseRef = useRef<Promise<HookBatchResult> | null>(null);
        const sessionStartContextsRef = useRef<string[]>([]);
        const shutdownPromiseRef = useRef<Promise<void> | null>(null);

        const recordHookIssues = (result: HookBatchResult) => {
            for (const issue of getHookExecutionIssues(result)) {
                eventStore.appendWarning(issue);
            }
        };
        const startSessionHooks = (): Promise<HookBatchResult> => {
            sessionStartPromiseRef.current ??= rootSession.runSessionStart(
                initialSession ? "resume" : "startup",
                sessionHookControllerRef.current!.signal
            ).then((result) => {
                recordHookIssues(result);
                sessionStartContextsRef.current = formatHookContext(
                    "SessionStart",
                    result.additionalContexts
                );
                return result;
            }).catch((error) => {
                const message = error instanceof Error
                    ? error.message
                    : String(error);
                eventStore.appendWarning(
                    `SessionStart Hook 执行失败: ${message.slice(0, 300)}`
                );
                return {
                    blocked: false,
                    additionalContexts: [],
                    executions: [],
                };
            });
            return sessionStartPromiseRef.current;
        };

        const permissionRequestsRef = useRef<UIPermissionRequests | null>(null);
        if (permissionRequestsRef.current === null) {
            permissionRequestsRef.current = new UIPermissionRequests();
        }
        const permissionRequests = permissionRequestsRef.current;

        const sessionQueueRef = useRef<SessionSnapshotQueue | null>(null);
        if (sessionQueueRef.current === null) {
            sessionQueueRef.current = new SessionSnapshotQueue(
                (snapshot) => saveSessionSnapshot(resources.storage, snapshot),
                (error) => {
                    const detail = error instanceof Error ? error.message : String(error);
                    const bounded = detail.length > 240 ? `${detail.slice(0, 239)}…` : detail;
                    eventStore.appendWarning(
                        `会话保存失败，本次对话可能无法通过 /resume 恢复：${bounded}`
                    );
                }
            );
        }
        const sessionQueue = sessionQueueRef.current;

        const createSnapshot = useCallback(
            (overrides?: {
                todos?: Todo[];
                permissionMode?: PermissionMode;
                prePlanMode?: PermissionMode;
                allowEmpty?: boolean;
                summaryHint?: string;
            }): SaveSessionSnapshotInput => rootSession.createSnapshot({
                todos: [...(overrides?.todos ?? todosRef.current)],
                permissionMode:
                    overrides?.permissionMode ?? permissionModeRef.current,
                prePlanMode: overrides?.prePlanMode ?? prePlanModeRef.current,
                uiEvents: eventStore.getPersistedUIEvents(),
                allowEmpty: overrides?.allowEmpty,
                summaryHint: overrides?.summaryHint,
            }),
            [eventStore, rootSession]
        );

        const persistSnapshot = useCallback(
            (overrides?: {
                todos?: Todo[];
                permissionMode?: PermissionMode;
                prePlanMode?: PermissionMode;
                allowEmpty?: boolean;
                summaryHint?: string;
            }) => sessionQueue.enqueue(createSnapshot(overrides)),
            [createSnapshot, sessionQueue]
        );
        useEffect(() => {
            let active = true;
            void initializeSession()
                .then(() => {
                    return persistSnapshot();
                })
                .catch((error) => {
                    const message = error instanceof Error
                        ? error.message
                        : String(error);
                    if (active) {
                        setSessionInitializationError(message.slice(0, 500));
                    }
                    eventStore.appendError(
                        new Error(`Session Runtime 初始化失败：${message}`)
                    );
                });
            return () => {
                active = false;
            };
        }, [eventStore, initializeSession, persistSnapshot]);

        const setPermissionMode = useCallback(
            (mode: PermissionMode) => {
                const current = permissionModeRef.current;
                if (mode === "plan" && current !== "plan") {
                    prePlanModeRef.current = current;
                } else if (current === "plan" && mode !== "plan") {
                    prePlanModeRef.current = undefined;
                }
                permissionModeRef.current = mode;
                setPermissionModeState(mode);
                void persistSnapshot({
                    permissionMode: mode,
                    prePlanMode: prePlanModeRef.current,
                });
            },
            [persistSnapshot]
        );

        const setTodos = useCallback(
            (nextTodos: Todo[]) => {
                todosRef.current = nextTodos;
                setTodosState(nextTodos);
                void persistSnapshot({todos: nextTodos});
            },
            [persistSnapshot]
        );

        const canUseTool = useCallback(
            (
                toolName: string,
                message: string,
                input: unknown
            ): Promise<PermissionDecision> =>
                permissionRequests.request(toolName, message, input),
            [permissionRequests]
        );

        const turnControllerRef = useRef<UITurnController | null>(null);
        if (turnControllerRef.current === null) {
            turnControllerRef.current = new UITurnController({
                getHistory: () => rootSession.history,
                createContext: (signal) => rootSession.createContext({
                    signal,
                    onEvent: eventStore.handleEvent,
                    host: {
                        canUseTool,
                        getPermissionRules: () => permissionRulesRef.current!,
                        getPermissionMode: () => permissionModeRef.current,
                        getPrePlanMode: () => prePlanModeRef.current,
                        setPermissionMode,
                        setTodos,
                    },
                }),
                onUserInput: (input) => eventStore.appendUser(input),
                onEvent: eventStore.handleEvent,
                onUnexpectedError: (error) => eventStore.appendError(error),
                onQueuedInputConsumed: (input) => eventStore.appendUser(input),
                onTurnSettled: () => eventStore.settleTurn(),
                denyPendingPermission: (message) => {
                    permissionRequests.denyPending(message);
                },
                initialize: initializeSession,
                slashCommands: createSlashCommandProcessor({
                    compactHistory: resources.agentRuntime.compactHistory,
                    getToolSchemas: toolRuntime.getToolSchemas,
                    subagents: resources.subagents,
                    memory: resources.memory,
                }),
                openRewind,
                openAgents,
                openGitDiff,
                openModel,
                runUserPromptHooks: async (input, ctx) => {
                    await startSessionHooks();
                    if (ctx.signal.aborted) {
                        return {
                            blocked: false,
                            additionalUserContextBlocks:
                                sessionStartContextsRef.current,
                        };
                    }
                    const result = await rootSession.runUserPromptHooks(
                        input,
                        permissionModeRef.current,
                        ctx.signal
                    );
                    recordHookIssues(result);
                    return {
                        blocked: result.blocked,
                        ...(result.blockReason
                            ? {blockReason: result.blockReason}
                            : {}),
                        additionalUserContextBlocks: [
                            ...sessionStartContextsRef.current,
                            ...formatHookContext(
                                "UserPromptSubmit",
                                result.additionalContexts
                            ),
                        ],
                    };
                },
                beginCheckpoint: async (input) => {
                    try {
                        await rootSession.beginCheckpoint(input, {
                            todos: todosRef.current,
                            permissionMode: permissionModeRef.current,
                            prePlanMode: prePlanModeRef.current,
                            uiEvents: eventStore.getPersistedUIEvents(),
                        });
                    } catch (error) {
                        eventStore.appendWarning(
                            `File Checkpoint 创建失败，本轮已阻止执行：${error instanceof Error ? error.message : String(error)}`
                        );
                        throw error;
                    }
                },
                settleCheckpoint: async () => {
                    try {
                        await rootSession.settleCheckpoint();
                    } catch (error) {
                        eventStore.appendWarning(
                            `File Checkpoint 收尾失败：${error instanceof Error ? error.message : String(error)}`
                        );
                        throw error;
                    }
                },
                runAgent: runAgentImpl,
                persistSnapshot: () => persistSnapshot(),
                getToolSchemas: toolRuntime.getToolSchemas,
                executeTool: toolRuntime.executeTool,
                isToolConcurrencySafe: toolRuntime.isConcurrencySafe,
                messageQueue,
                now: Date.now,
            });
        }
        const turnController = turnControllerRef.current;

        const turnStatus = useSyncExternalStore(
            turnController.subscribe,
            turnController.getSnapshot,
            turnController.getSnapshot
        );
        const eventSnapshot = useSyncExternalStore(
            eventStore.subscribe,
            eventStore.getSnapshot,
            eventStore.getSnapshot
        );
        const confirmRequest = useSyncExternalStore(
            permissionRequests.subscribe,
            permissionRequests.getSnapshot,
            permissionRequests.getSnapshot
        );
        const messageQueueSnapshot = useSyncExternalStore(
            messageQueue.subscribe,
            messageQueue.getSnapshot,
            messageQueue.getSnapshot
        );

        const shutdown = useCallback((): Promise<void> => {
            if (shutdownPromiseRef.current) return shutdownPromiseRef.current;
            shutdownPromiseRef.current = (async () => {
                turnController.dispose();
                permissionRequests.dispose();
                await turnController.waitForSettled();
                sessionHookControllerRef.current?.abort("shutdown");
                await sessionStartPromiseRef.current?.catch(() => undefined);
                const endController = new AbortController();
                const timer = setTimeout(
                    () => endController.abort("session-end-timeout"),
                    1_500
                );
                timer.unref?.();
                await rootSession.runSessionEnd("shutdown", endController.signal)
                    .catch(() => undefined)
                    .finally(() => clearTimeout(timer));
                await persistSnapshot();
                await sessionQueue.drain();
            })();
            return shutdownPromiseRef.current;
        }, [permissionRequests, persistSnapshot, rootSession, sessionQueue, turnController]);

        useEffect(() => {
            void startSessionHooks();
            return () => {
                void shutdown();
            };
        }, [shutdown]);

        useEffect(() => {
            const drainNotifications = async () => {
                for (const notification of await taskSession.claimNotifications()) {
                    messageQueue.enqueueTask(notification);
                    eventStore.appendTaskNotification(notification);
                }
            };
            const drain = () => {
                void drainNotifications().catch((error) => {
                    eventStore.appendNotice(
                        `后台任务通知读取失败：${
                            error instanceof Error ? error.message : String(error)
                        }`
                    );
                });
            };
            drain();
            return taskSession.subscribe(() => {
                drain();
            });
        }, [eventStore, messageQueue, taskSession]);

        useEffect(() => {
            if (turnStatus.busy || messageQueueSnapshot.messages.length === 0) {
                return;
            }
            void persistSnapshot();
        }, [messageQueueSnapshot, persistSnapshot, turnStatus.busy]);

        const handleAddToAllowList = useCallback(
            async (rule: string): Promise<void> => {
                const nextRules = await addToAllowList(
                    rule,
                    permissionRulesRef.current!,
                    cwd
                );
                permissionRulesRef.current = nextRules;
            },
            [cwd]
        );

        const setPrimaryModel = useCallback(
            (target: ModelTargetSettings) => {
                resources.primaryModel.select(target);
                rootSession.replaceConversation(
                    updateInitialHistoryModel(rootSession.history, target.model),
                    rootSession.compactState
                );
                setPrimaryModelState(target);
                eventStore.updateTokenInfo(estimateRestoredTokenInfo(
                    rootSession.history,
                    resources.skills,
                    resources.instructions,
                    toolRuntime.getToolSchemas(),
                    target.model
                ));
                eventStore.appendNotice(
                    `已切换主模型：${formatModelTarget(target)}。Fast model 未改变。`
                );
                void persistSnapshot();
            },
            [eventStore, persistSnapshot, resources, rootSession, toolRuntime]
        );

        const applyRestoredState = useCallback((restored: {
            history: Parameters<typeof eventStore.restore>[0]["history"];
            todos: Todo[];
            permissionMode: PermissionMode;
            prePlanMode?: PermissionMode;
            uiEvents: Parameters<typeof eventStore.restore>[0]["uiEvents"];
            prompt: string;
        }) => {
            todosRef.current = [...restored.todos];
            setTodosState([...restored.todos]);
            permissionModeRef.current = restored.permissionMode;
            prePlanModeRef.current = restored.prePlanMode;
            setPermissionModeState(restored.permissionMode);
            eventStore.restore({
                history: restored.history,
                uiEvents: restored.uiEvents,
                tokenInfo: estimateRestoredTokenInfo(
                    restored.history,
                    resources.skills,
                    resources.instructions,
                    toolRuntime.getToolSchemas(),
                    resources.model
                ),
            });
            setInputReplacement((current) => ({
                value: restored.prompt,
                revision: (current?.revision ?? 0) + 1,
            }));
        }, [eventStore, resources, toolRuntime]);
        const checkpointActions = useMemo(() => createUICheckpointActions({
            resources,
            rootSession,
            eventStore,
            sessionQueue,
            applyRestoredState,
        }), [
            applyRestoredState,
            eventStore,
            resources,
            rootSession,
            sessionQueue,
        ]);

        return {
            sessionId: rootSession.sessionId,
            sessionInitializationError,
            busy: turnStatus.busy,
            stopping: turnStatus.stopping,
            startedAt: turnStatus.startedAt,
            elapsedMs: turnStatus.elapsedMs,
            threads: eventSnapshot.threads,
            staticThreads: eventSnapshot.staticThreads,
            liveThreads: selectLiveThreads(
                eventSnapshot.threads,
                eventSnapshot.staticThreads
            ),
            tokenInfo: eventSnapshot.tokenInfo,
            modelStream: eventSnapshot.modelStream,
            modelStreamProgressRef: eventStore.getModelStreamProgressRef(),
            todos,
            permissionMode,
            primaryModel,
            availableModels: resources.primaryModel.available,
            prePlanMode: prePlanModeRef.current,
            confirmRequest,
            submit: turnController.submit.bind(turnController),
            enqueue: turnController.enqueue.bind(turnController),
            cancel: turnController.cancel.bind(turnController),
            takeQueuedInputsForEditing:
                turnController.takeQueuedInputsForEditing.bind(turnController),
            setPermissionMode,
            setPrimaryModel,
            clearConfirmRequest: (request: ConfirmReq | null) =>
                permissionRequests.clear(request),
            handleAddToAllowList,
            inputReplacement,
            queuedMessages: messageQueueSnapshot.messages,
            backgroundTasks: taskSession.getRunningSummary(),
            ...checkpointActions,
            shutdown,
        };
}
