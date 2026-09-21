import {FileSuggestions} from "../../runtime/fileSuggestions.js";
import {importSelectedImages} from "../../runtime/imageInput.js";
import {supportsToolImages} from "../../images/capability.js";
import {imageReferences, type MessageContent} from "../../images/content.js";
import {useCallback, useEffect, useRef, useState, useSyncExternalStore,} from "react";
import {updateInitialHistoryModel} from "../../prompt/index.js";
import {createSlashCommandProcessor} from "../../slash/index.js";
import {
    type LoadedSession,
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
import {createTaskNotificationDelivery} from "../../runtime/taskNotificationDelivery.js";
import {estimateRestoredTokenInfo} from "./tokenInfo.js";
import {formatAgentLoadWarning} from "../../subagents/diagnostics.js";
import {formatHookContext, getHookExecutionIssues, type HookBatchResult,} from "../../hooks/index.js";
import type {RootSessionRuntime} from "../../runtime/sessionRuntime.js";
import {runRootTurn} from "../../runtime/turnRuntime.js";
import type {ModelTargetSettings} from "../../settings/types.js";
import {formatModelTarget} from "../../llm/modelCatalog.js";

export interface UseTurnControllerOptions {
    resources: RootRuntimeResources;
    initialPermissionMode?: PermissionMode;
    initialCollaborationMode?: CollaborationMode;
    initialSession?: LoadedSession;
    rootSession: RootSessionRuntime;
    resumedDraft?: MessageContent;
    openResume?: () => void;
    openAgents?: () => void;
    openSkills?: () => void;
    openTasks?: () => void;
    openGitDiff?: () => void;
    openModel?: () => void;
    openProviders?: () => void;
    openPermissions?: () => void;
}

/** Only threads needing updates belong in Ink's live area. File diffs merge within an iteration; rendering them live can push them into scrollback and duplicate them when moved to scrollback. Show each final diff once at the iteration/turn boundary. */
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
                                          openAgents,
                                          openSkills,
                                          openTasks,
                                          openGitDiff,
                                          openModel,
                                          openProviders,
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
                        model,
                        resources.settings.context
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
                    `SessionStart Hook failed: ${message.slice(0, 300)}`
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

        const lastSaveError = useRef<string | undefined>(undefined);
        const saveSnapshot = useCallback(async (snapshot: SaveSessionSnapshotInput) => {
            try {
                await rootSession.saveSnapshot(snapshot);
                lastSaveError.current = undefined;
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                if (lastSaveError.current !== detail) eventStore.appendWarning(`Session save failed; this conversation may not be available through /resume: ${detail.slice(0, 240)}`);
                lastSaveError.current = detail;
            }
        }, [rootSession, eventStore]);

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
            }) => saveSnapshot(createSnapshot(overrides)),
            [createSnapshot, saveSnapshot]
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
                        new Error(`Session Runtime initialization failed: ${message}`)
                    );
                });
            return () => {
                active = false;
            };
        }, [eventStore, initializeSession, persistSnapshot]);

        const setPermissionMode = useCallback(
            (mode: PermissionMode) => {
                if (mode === "full-access" && !resources.allowFullAccess) return;
                rootSession.invalidateApprovals();
                permissionModeRef.current = mode;
                setPermissionModeState(mode);
                void persistSnapshot({permissionMode: mode});
            },
            [persistSnapshot]
        );

        const setCollaborationMode = useCallback(
            (mode: CollaborationMode) => {
                rootSession.invalidateApprovals();
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

        const fileSuggestionsRef = useRef<FileSuggestions | null>(null);
        fileSuggestionsRef.current ??= new FileSuggestions(signal => rootSession.createContext({
            signal, onEvent: () => {},
            host: {
                canUseTool: async () => ({behavior: "deny", message: "File suggestions cannot request additional permissions; type a path directly"}),
                getPermissionRules: () => permissionRulesRef.current!,
                getPermissionMode: () => "ask", getCollaborationMode: () => "plan",
                getPermissionPromptPolicy: () => "never", setTodos() {},
            },
            getSnapshotState: () => ({...createSnapshot(), uiEvents: eventStore.getPersistedUIEvents()}),
        }));
        const fileSuggestions = fileSuggestionsRef.current;

        const turnControllerRef = useRef<UITurnController | null>(null);
        if (turnControllerRef.current === null) {
            const toolContextHost = {
                canUseTool,
                getPermissionRules: () => permissionRulesRef.current!,
                getPermissionMode: () => permissionModeRef.current,
                getCollaborationMode: () => collaborationModeRef.current,
                getPermissionPromptPolicy: () => "onRequest" as const,
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
                openAgents,
                openSkills,
                openTasks,
                toolRuntime,
                openGitDiff,
                openModel,
                openProviders,
                openPermissions,
                setCollaborationMode,
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
                                `${issue.message}:${issue.error instanceof Error ? issue.error.message : String(issue.error)}`
                            );
                        },
                        onTurnSettled: () => {fileSuggestions.invalidate(); eventStore.settleTurn();},
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
                validateImages: content => {
                    if (!(typeof content === "string" && content.trim().startsWith("/")) &&
                        !resources.primaryModel.isConfigured) {
                        if (resources.primaryModel.available.length) openModel?.(); else openProviders?.();
                        throw new Error("Configure a provider with /providers and choose a model with /model. Your input is preserved.");
                    }
                    const target = resources.primaryModel.target;
                    if (imageReferences(content).length && !supportsToolImages(resources.primaryModel.sources[target.source], target.model))
                        throw new Error("This model does not support images. Attachments and input are preserved; switch models first.");
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
                await fileSuggestions.close();
                permissionRequests.dispose();
                await turnController.waitForSettled();
                sessionHookControllerRef.current?.abort("shutdown");
                await sessionStartPromiseRef.current?.catch(() => undefined);
                await rootSession.runSessionEnd("shutdown", eventStore.handleEvent)
                    .catch(() => undefined);
                await persistSnapshot();
                await rootSession.flushSnapshots();
            })();
            return shutdownPromiseRef.current;
        }, [fileSuggestions, permissionRequests, persistSnapshot, rootSession, turnController]);

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
                persist: () => rootSession.saveSnapshot(createSnapshot()),
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
                    if (message !== lastError) eventStore.appendNotice(`Background task notification awaiting redelivery: ${message}`);
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
        }, [createSnapshot, eventStore, messageQueue, rootSession, taskSession]);

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
            async (target: ModelTargetSettings) => {
                if (!resources.modelConfiguration) throw new Error("This Host does not allow saving model configuration");
                await resources.modelConfiguration.saveSelection(target);
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
                    target.model,
                    resources.settings.context
                ));
                eventStore.appendNotice(
                    `Switched to ${formatModelTarget(target)}.`
                );
                void persistSnapshot();
            },
            [eventStore, persistSnapshot, resources, rootSession, toolRuntime]
        );

        const loadGitDiff = useCallback(
            (signal: AbortSignal) => resources.gitWorkspace.diff(signal),
            [resources.gitWorkspace]
        );

        return {
            fileSuggestions,
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
            stopTask: turnController.stopTask.bind(turnController),
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
            loadGitDiff,
            shutdown,
        };
}
