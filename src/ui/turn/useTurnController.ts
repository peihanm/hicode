import {readClipboardImage} from "../../cli/clipboard.js";
import {importUserInput} from "../../images/input.js";
import {importSelectedImages} from "../../runtime/imageInput.js";
import {supportsToolImages} from "../../images/capability.js";
import {imageReferences, type MessageContent} from "../../images/content.js";
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
import type {CollaborationMode} from "../../collaboration/index.js";
import type {RootRuntimeResources} from "../../runtime/resources.js";
import type {Todo} from "../../todos.js";
import type {UIThread} from "../conversation/types.js";
import type {ConfirmReq} from "./types.js";
import {UITurnController} from "./controller.js";
import {UITurnEventStore} from "./eventStore.js";
import {UIPermissionRequests} from "./permissionRequests.js";
import {SessionSnapshotQueue} from "./sessionQueue.js";
import {createTaskNotificationDelivery} from "../../runtime/taskNotificationDelivery.js";
import {estimateRestoredTokenInfo} from "./tokenInfo.js";
import {formatAgentLoadWarning} from "../../subagents/diagnostics.js";
import {formatHookContext, getHookExecutionIssues, type HookBatchResult,} from "../../hooks/index.js";
import type {RootSessionRuntime} from "../../runtime/sessionRuntime.js";
import {runRootTurn} from "../../runtime/turnRuntime.js";
import type {ModelTargetSettings} from "../../settings/types.js";
import {formatModelTarget} from "../../llm/modelCatalog.js";
import {createUICheckpointActions} from "./checkpointActions.js";

export interface UseTurnControllerOptions {
    resources: RootRuntimeResources;
    initialPermissionMode?: PermissionMode;
    initialCollaborationMode?: CollaborationMode;
    initialSession?: LoadedSession;
    rootSession: RootSessionRuntime;
    resumedDraft?: MessageContent;
    openResume?: () => void;
    openRewind?: () => void;
    openAgents?: () => void;
    openGitDiff?: () => void;
    openModel?: () => void;
    openPermissions?: () => void;
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
                                          initialCollaborationMode,
                                          initialSession,
                                          rootSession,
                                          resumedDraft,
                                          openResume,
                                          openRewind,
                                          openAgents,
                                          openGitDiff,
                                          openModel,
                                          openPermissions,
                                      }: UseTurnControllerOptions) {
        const {cwd, model, toolRuntime} = resources;
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
        const [collaborationMode, setCollaborationModeState] =
            useState<CollaborationMode>(
                () => initialCollaborationMode ?? initialSession?.collaborationMode ?? "build"
            );
        const collaborationModeRef = useRef<CollaborationMode>(collaborationMode);
        const [todos, setTodosState] = useState<Todo[]>(
            () => initialSession?.todos ?? []
        );
        const todosRef = useRef<Todo[]>(todos);
        const [inputReplacement, setInputReplacement] = useState<{
            value: string;
            revision: number;
            appendCurrent?: boolean;
        } | undefined>(() => resumedDraft
            ? {value: typeof resumedDraft === "string" ? resumedDraft : resumedDraft.filter(part => part.type === "text").map(part => part.text).join("\n"), revision: 1}
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
                sessionHookControllerRef.current!.signal,
                eventStore.handleEvent
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
                collaborationMode?: CollaborationMode;
                allowEmpty?: boolean;
                summaryHint?: string;
            }): SaveSessionSnapshotInput => rootSession.createSnapshot({
                todos: [...(overrides?.todos ?? todosRef.current)],
                permissionMode:
                    overrides?.permissionMode ?? permissionModeRef.current,
                collaborationMode:
                    overrides?.collaborationMode ?? collaborationModeRef.current,
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
                collaborationMode?: CollaborationMode;
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
                permissionModeRef.current = mode;
                setPermissionModeState(mode);
                void persistSnapshot({permissionMode: mode});
            },
            [persistSnapshot]
        );

        const setCollaborationMode = useCallback(
            (mode: CollaborationMode) => {
                collaborationModeRef.current = mode;
                setCollaborationModeState(mode);
                void persistSnapshot({collaborationMode: mode});
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
                input: unknown,
                options?: Parameters<UIPermissionRequests["request"]>[3]
            ): Promise<PermissionDecision> =>
                permissionRequests.request(toolName, message, input, options),
            [permissionRequests]
        );

        const turnControllerRef = useRef<UITurnController | null>(null);
        if (turnControllerRef.current === null) {
            const toolContextHost = {
                canUseTool,
                getPermissionRules: () => permissionRulesRef.current!,
                getPermissionMode: () => permissionModeRef.current,
                getCollaborationMode: () => collaborationModeRef.current,
                getPermissionPromptPolicy: () => "onRequest" as const,
                setPermissionMode,
                setCollaborationMode,
                setTodos,
            };
            turnControllerRef.current = new UITurnController({
                getHistory: () => rootSession.history,
                createContext: (signal) => rootSession.createContext({
                    signal,
                    onEvent: eventStore.handleEvent,
                    host: toolContextHost,
                    getSnapshotState: () => { const state = createSnapshot(); return {...state, uiEvents: state.uiEvents ?? []}; },
                }),
                onUserInput: (input) => eventStore.appendUser(input),
                onEvent: eventStore.handleEvent,
                onUnexpectedError: (error) => eventStore.appendError(error),
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
                openResume,
                openRewind,
                openAgents,
                openGitDiff,
                openModel,
                openPermissions,
                runTurn: async (input, signal) => {
                    await startSessionHooks();
                    await runRootTurn({
                        resources,
                        session: rootSession,
                        prompt: input,
                        signal,
                        host: toolContextHost,
                        onEvent: eventStore.handleEvent,
                        onHookResult: (result) => {
                            recordHookIssues(result);
                        },
                        onLifecycleIssue: (issue) => {
                            eventStore.appendWarning(
                                `${issue.message}：${issue.error instanceof Error ? issue.error.message : String(issue.error)}`
                            );
                        },
                        onTurnSettled: () => eventStore.settleTurn(),
                        getSnapshotState: () => ({
                            todos: todosRef.current,
                            permissionMode: permissionModeRef.current,
                            collaborationMode: collaborationModeRef.current,
                            uiEvents: eventStore.getPersistedUIEvents(),
                        }),
                        sessionStartContextBlocks:
                            sessionStartContextsRef.current,
                        inputChannel: messageQueue.createAgentInputChannel(
                            (message) => {
                                if (message.type === "user_input") {
                                    eventStore.appendUser(message.content);
                                }
                            }
                        ),
                    });
                },
                importImages: (paths, signal) => importSelectedImages(paths, resources, rootSession.createContext({signal, host: toolContextHost,
                    onEvent: eventStore.handleEvent, getSnapshotState: () => ({...createSnapshot(), uiEvents: eventStore.getPersistedUIEvents()})})),
                importClipboard: async signal => {
                    const target = resources.primaryModel.target;
                    const supported = supportsToolImages(resources.settings.sources[target.source], target.model);
                    if (!supported) throw new Error("当前模型不支持图片，请先切换模型再读取剪贴板");
                    const data = await readClipboardImage(signal);
                    const content = await importUserInput([{type: "image", data}], rootSession.toolResultStore, supported, signal);
                    return imageReferences(content).map(reference => ({...reference, label: "剪贴板图片"}));
                },
                validateImages: content => {
                    const target = resources.primaryModel.target;
                    if (imageReferences(content).length && !supportsToolImages(resources.settings.sources[target.source], target.model))
                        throw new Error("当前模型不支持图片；附件与输入已保留，请先切换模型");
                },
                restoreDraft: value => setInputReplacement(current => ({value, revision: (current?.revision ?? 0) + 1, appendCurrent: true})),
                messageQueue,
                now: Date.now,
            });
        }
        const turnController = turnControllerRef.current;
        useEffect(() => {if (resumedDraft) turnController.restoreAttachments(resumedDraft);}, [turnController, resumedDraft]);
        const attachmentState = useSyncExternalStore(turnController.subscribe, turnController.getAttachmentSnapshot, turnController.getAttachmentSnapshot);

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
                await rootSession.runSessionEnd("shutdown", eventStore.handleEvent)
                    .catch(() => undefined);
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
            let disposed = false;
            let retry: ReturnType<typeof setTimeout> | undefined;
            let lastError: string | undefined;
            const delivery = createTaskNotificationDelivery({
                tasks: taskSession, queue: messageQueue,
                persist: () => sessionQueue.enqueueCritical(createSnapshot()),
                onQueued: notification => eventStore.appendTaskNotification(notification),
            });
            let observed: Promise<void> | undefined;
            const drain = () => {
                if (disposed) return;
                const operation = delivery.drain();
                if (observed === operation) return;
                observed = operation;
                void operation.then(() => { lastError = undefined; }).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    if (message !== lastError) eventStore.appendNotice(`后台任务通知等待重投：${message}`);
                    lastError = message;
                    if (!disposed && retry === undefined) retry = setTimeout(() => { retry = undefined; drain(); }, 1_000);
                });
            };
            drain();
            const unsubscribeTasks = taskSession.subscribe(drain);
            const unsubscribeQueue = messageQueue.subscribe(drain);
            return () => {
                disposed = true;
                if (retry !== undefined) clearTimeout(retry);
                unsubscribeTasks();
                unsubscribeQueue();
            };
        }, [createSnapshot, eventStore, messageQueue, sessionQueue, taskSession]);

        useEffect(() => {
            if (messageQueueSnapshot.messages.length === 0) {
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
                    `已切换主模型：${formatModelTarget(target)}。`
                );
                void persistSnapshot();
            },
            [eventStore, persistSnapshot, resources, rootSession, toolRuntime]
        );

        const applyRestoredState = useCallback((restored: {
            history: Parameters<typeof eventStore.restore>[0]["history"];
            todos: Todo[];
            permissionMode: PermissionMode;
            collaborationMode: CollaborationMode;
            uiEvents: Parameters<typeof eventStore.restore>[0]["uiEvents"];
            prompt: MessageContent;
        }) => {
            todosRef.current = [...restored.todos];
            setTodosState([...restored.todos]);
            permissionModeRef.current = restored.permissionMode;
            collaborationModeRef.current = restored.collaborationMode;
            setPermissionModeState(restored.permissionMode);
            setCollaborationModeState(restored.collaborationMode);
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
            const restoredDraft = turnController.restoreAttachments(restored.prompt);
            setInputReplacement((current) => ({
                value: restoredDraft,
                revision: (current?.revision ?? 0) + 1,
            }));
        }, [eventStore, resources, toolRuntime]);
        const checkpointActions = useMemo(() => createUICheckpointActions({
            getPermissionMode: () => permissionModeRef.current,
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
            draftStore: eventStore,
            modelStream: eventSnapshot.modelStream,
            modelStreamProgressRef: eventStore.getModelStreamProgressRef(),
            todos,
            permissionMode,
            collaborationMode,
            primaryModel,
            availableModels: resources.primaryModel.available,
            confirmRequest,
            attachmentState,
            attachmentCommand: turnController.attachmentCommand.bind(turnController),
            addImages: turnController.addImages.bind(turnController),
            pasteImage: turnController.pasteImage.bind(turnController),
            removeAttachment: turnController.removeAttachment.bind(turnController),
            submit: turnController.submit.bind(turnController),
            enqueue: turnController.enqueue.bind(turnController),
            cancel: turnController.cancel.bind(turnController),
            takeQueuedInputsForEditing:
                turnController.takeQueuedInputsForEditing.bind(turnController),
            setPermissionMode,
            setCollaborationMode,
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
