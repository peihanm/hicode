import {McpDialog} from "./mcp/McpDialog.js";
import {McpStatus} from "./mcp/McpStatus.js";
import {DraftLayoutProvider} from "./conversation/draftLayout.js";
import {isCoordinationWait} from "./conversation/projection.js";
import {ProvidersDialog} from "./providers/ProvidersDialog.js";
import type {MessageContent} from "../images/content.js";
import {AssistantDraftView} from "./conversation/AssistantDraftView.js";
import {useRef, useCallback, useEffect, useMemo, useState, type ReactNode} from "react";
import {Box, Text, useApp, useInput} from "ink";
import {listSessionIndex, type LoadedSession, type SessionIndexEntry,} from "../session/index.js";
import type {PermissionMode} from "../permissions/index.js";
import {getNextCollaborationMode, type CollaborationMode} from "../collaboration/index.js";
import type {RootRuntimeResources} from "../runtime/resources.js";
import {MessageList} from "./conversation/MessageList.js";
import {ScrollbackTranscript} from "./conversation/ScrollbackTranscript.js";
import {InputBox} from "./input/InputBox.js";
import {ConfirmDialog} from "./dialogs/ConfirmDialog.js";
import {
    FileAccessDialog,
    isFileAccessRequest,
} from "./dialogs/FileAccessDialog.js";
import {isNetworkAccessRequest, NetworkAccessDialog} from "./dialogs/NetworkAccessDialog.js";
import {ElevatedBashDialog, isElevatedBashRequest,} from "./dialogs/ElevatedBashDialog.js";
import {AskDialog} from "./dialogs/AskDialog.js";
import {PermissionsDialog} from "./dialogs/PermissionsDialog.js";
import {StatusBar} from "./status/StatusBar.js";
import {TodoList} from "./status/TodoList.js";
import {ModelStreamStatus} from "./status/ModelStreamStatus.js";
import {selectLiveThreads, useTurnController} from "./turn/useTurnController.js";
import type {UIThread} from "./conversation/types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import {GitDiffDialog} from "./git/GitDiffDialog.js";
import {TasksDialog} from "./tasks/TasksDialog.js";
import {SandboxDialog} from "./sandbox/SandboxDialog.js";
import {saveLocalNetworkMode} from "../settings/permissionUpdate.js";
import {SkillsDialog} from "./skills/SkillsDialog.js";
import {join} from "node:path";
import {AgentsDialog} from "./agents/AgentsDialog.js";
import {QueuedInputPreview} from "./input/QueuedInputPreview.js";
import {ModelDialog} from "./model/ModelDialog.js";
import {COLORS} from "./theme.js";
import type {RootSessionRuntime} from "../runtime/sessionRuntime.js";
import {ResumeDialog} from "./resume/ResumeDialog.js";

function runningActivityLabel(
    threads: UIThread[],
    subagents: SubagentRegistry,
    runningAgents: number
): string | undefined {
    const hook = [...threads].reverse().find(thread => thread.role === "hook" && thread.status === "running");
    if (hook?.role === "hook") return `Running Hook ${hook.execution.event}...`;
    const running = [...threads].reverse().find(
        (thread): thread is Extract<UIThread, { role: "tool_call" }> =>
            thread.role === "tool_call" && thread.status === "running"
    );
    if (!running) return undefined;
    if (running.approvalReview) return running.approvalReview;
    if (isCoordinationWait(running)) return running.name === "task"
        ? `Waiting for agents · ${runningAgents} running · /tasks`
        : "Waiting for an agent message...";
    if (running.name !== "agent") return `Executing ${running.name}...`;

    let agentType = running.subagentType;
    let agentName = running.subagentName;
    try {
        const parsed = JSON.parse(running.args) as Record<string, unknown>;
        const role = typeof parsed.subagent_type === "string" ? parsed.subagent_type : "Worker";
        if (!agentType && subagents.has(role)) agentType = role;
        if (!agentName && typeof parsed.name === "string") agentName = parsed.name;
    } catch {
        // The tool layer reports invalid arguments; the status line uses known lifecycle fields.
    }
    const label = agentName ? `${agentName} (${agentType ?? "Agent"})` : agentType ?? "Agent";
    return `Running ${label} Agent...`;
}

export function App({
                            resources,
                            runtimeApproval,
                            initialPermissionMode,
                            initialCollaborationMode,
        initialImages,
                            initialSession,
                            rootSession,
                            resumedDraft,
                            registerSessionShutdown,
                            requestSessionSwitch,
                        }: {
        resources: RootRuntimeResources;
        runtimeApproval?: ReactNode;
        initialPermissionMode?: PermissionMode;
        initialCollaborationMode?: CollaborationMode;
    initialImages?: readonly string[];
        initialSession?: LoadedSession;
        rootSession: RootSessionRuntime;
        resumedDraft?: MessageContent;
        registerSessionShutdown?: (shutdown: () => Promise<void>) => void;
        requestSessionSwitch?: (sessionId: string) => Promise<void>;
    }) {
        const {exit} = useApp();
        const inputEscapeRef = useRef<(() => boolean) | undefined>(undefined);
        const setInputEscapeHandler = useCallback((handler: (() => boolean) | undefined) => {inputEscapeRef.current = handler;}, []);
        const [activePanel, setActivePanel] = useState<"resume" | "tasks" | "agents" | "mcp" | "skills" | "sandbox" | "diff" | "providers" | "model" | "permissions" | undefined>(() => {
            if (resources.modelConfiguration && resources.primaryModel.available.length === 0) return "providers";
            if (resources.primaryModel.available.length > 0 && !resources.primaryModel.isConfigured) return "model";
            return undefined;
        });
        const [resumeError, setResumeError] = useState<string>();
        const [resumeSessions, setResumeSessions] = useState<SessionIndexEntry[]>([]);
        const [configuredNetworkMode, setConfiguredNetworkMode] = useState(resources.settings.sandbox.network.mode);
        const openResume = useCallback(() => {
            try {setResumeSessions(listSessionIndex(resources.storage, resources.cwd)); setResumeError(undefined);}
            catch (error) {setResumeSessions([]); setResumeError(error instanceof Error ? error.message : "Cannot read session index");}
            setActivePanel("resume");
        }, [resources.cwd, resources.storage]);
        const openAgents = useCallback(() => setActivePanel("agents"), []);
        const openMcp = useCallback(() => setActivePanel("mcp"), []);
        const openSkills = useCallback(() => setActivePanel("skills"), []);
        const openSandbox = useCallback(() => setActivePanel("sandbox"), []);
        const openGitDiff = useCallback(() => setActivePanel("diff"), []);
        const openProviders = useCallback(() => setActivePanel("providers"), []);
        const openModel = useCallback(() => setActivePanel("model"), []);
        const openPermissions = useCallback(() => setActivePanel("permissions"), []);
        const openTasks = useCallback(() => setActivePanel("tasks"), []);
        const turn = useTurnController({
            resources,
            initialPermissionMode,
            initialCollaborationMode,
            initialSession,
            rootSession,
            resumedDraft,
            openResume: requestSessionSwitch ? openResume : undefined,
            openAgents,
            openSkills,
            openMcp,
            openSandbox,
            openTasks,
            openGitDiff,
            openModel,
            openProviders: resources.modelConfiguration ? openProviders : undefined,
            openPermissions,
        });
        const initialImagesLoaded = useRef(false);
        useEffect(() => {
            if (initialImagesLoaded.current || !initialImages?.length) return;
            initialImagesLoaded.current = true;
            void turn.addImages(initialImages);
        }, [initialImages, turn]);
        const [showTranscript, setShowTranscript] = useState(false);
        const [hasInputDraft, setHasInputDraft] = useState(false);
        const [inputClearRevision, setInputClearRevision] = useState(0);
        useEffect(() => {
            registerSessionShutdown?.(turn.shutdown);
        }, [registerSessionShutdown, turn.shutdown]);
        const requestExit = useCallback(() => {
            // Abort background tasks synchronously so bounded CLI shutdown cannot leave detached processes.
            resources.beginShutdown();
            exit();
        }, [exit, resources]);

        const closeConfiguration = useCallback(() => {
            if (!resources.primaryModel.isConfigured) {
                requestExit();
                return;
            }
            setActivePanel(undefined);
        }, [requestExit, resources.primaryModel]);

        const handleSubmit = useCallback(
            async (input: string) => {
                if (input === "exit" || input === "quit") {
                    requestExit();
                    return;
                }
                if (turn.busy) {
                    turn.enqueue(input);
                    return;
                }
                await turn.submit(input);
            },
            [requestExit, turn]
        );

        useInput((input, key) => {
            if (runtimeApproval) return;
            const isCtrlC = (key.ctrl && input === "c") || input === "\x03";
            if (activePanel !== undefined) return;
            if ((key.escape || input === "\u001B") && !turn.confirmRequest && inputEscapeRef.current?.()) return;
            const isCancel = key.escape || input === "\u001B" || isCtrlC;
            if (
                (turn.busy || turn.attachmentState.preparing) &&
                isCancel
            ) {
                turn.cancel();
                return;
            }
            if (!turn.busy && isCtrlC) {
                if (hasInputDraft) {
                    turn.removeAttachment("all");
                    setInputClearRevision((revision) => revision + 1);
                    return;
                }
                void requestExit();
                return;
            }
            if (!turn.confirmRequest && key.shift && key.tab) {
                turn.setCollaborationMode(
                    getNextCollaborationMode(turn.collaborationMode)
                );
                return;
            }
            if (key.ctrl && input === "o") {
                setShowTranscript((previous) => !previous);
            }
        });

        const display = useMemo(() => {
            if (!showTranscript) {
                return {settled: turn.staticThreads, live: selectLiveThreads(turn.threads, turn.staticThreads)};
            }
            const settled: UIThread[] = [];
            const live: UIThread[] = [];
            const archivedIds = new Set(turn.staticThreads.map(thread => thread.id));
            for (const thread of turn.threads) {
                // Diffs merge during a tool batch. Wait for the same stable boundary
                // in both display modes rather than replaying partial patches.
                if (thread.role === "file_change_group" && !archivedIds.has(thread.id)) continue;
                const running = (thread.role === "tool_call" || thread.role === "hook") && thread.status === "running";
                (running ? live : settled).push(thread);
            }
            return {settled, live};
        }, [showTranscript, turn.threads, turn.staticThreads]);

        const {cwd, mcpManager} = resources;
        const [mcpSnapshots, setMcpSnapshots] = useState(() => mcpManager?.getSnapshots() ?? []);
        useEffect(() => {
            const update = () => setMcpSnapshots(mcpManager?.getSnapshots() ?? []);
            const unsubscribe = mcpManager?.subscribe(update);
            update();
            return unsubscribe;
        }, [mcpManager]);
        const activityLabel = runningActivityLabel(
            turn.liveThreads,
            resources.subagents,
            turn.backgroundTasks.agent
        );
        return (
            <DraftLayoutProvider store={turn.draftStore}><Box flexDirection="column">
                <ScrollbackTranscript threads={display.settled} showWelcome expanded={showTranscript}
                    transientPanelId={turn.confirmRequest?.id}/>

                <MessageList
                    threads={display.live}
                    paused={!!turn.confirmRequest}
                />

                {turn.busy && !turn.confirmRequest && activePanel === undefined && (
                    <AssistantDraftView phase={turn.modelStream?.phase}/>
                )}

                {activePanel === undefined && (
                    <TodoList
                        todos={turn.todos}
                        paused={!turn.busy || !!turn.confirmRequest}
                    />
                )}

                {turn.busy && !turn.confirmRequest && activePanel === undefined && (
                    <>
                        <ModelStreamStatus
                            modelStream={turn.modelStream}
                            progressRef={turn.modelStreamProgressRef}
                            stopping={turn.stopping}
                            activityLabel={activityLabel}
                        />
                    </>
                )}

                {!runtimeApproval && !turn.confirmRequest && activePanel === undefined && <McpStatus servers={mcpSnapshots}/>}
                {runtimeApproval ? runtimeApproval : (activePanel === "resume") && requestSessionSwitch ? (
                    <ResumeDialog indexError={resumeError}
                        sessions={resumeSessions}
                        currentSessionId={turn.sessionId}
                        onSelect={requestSessionSwitch}
                        onClose={() => setActivePanel(undefined)}
                    />
                ) : (activePanel === "providers") && resources.modelConfiguration ? (
                    <ProvidersDialog runtime={resources.primaryModel} configuration={resources.modelConfiguration} onSelect={turn.setPrimaryModel} onClose={closeConfiguration}/>
                ) : (activePanel === "model") ? (
                    <ModelDialog
                        models={turn.availableModels}
                        current={turn.primaryModel}
                        onSelect={async (target) => {
                            await turn.setPrimaryModel(target);
                            setActivePanel(undefined);
                        }}
                        escapeAction={resources.primaryModel.isConfigured ? "back" : "exit"}
                        onClose={closeConfiguration}
                    />
                ) : (activePanel === "permissions") ? (
                    <PermissionsDialog
                        allowFullAccess={resources.allowFullAccess}
                        current={turn.permissionMode}
                        onSelect={(mode) => {
                            turn.setPermissionMode(mode);
                            setActivePanel(undefined);
                        }}
                        onClose={() => setActivePanel(undefined)}
                    />
                ) : (activePanel === "tasks") && !turn.confirmRequest ? (
                    <TasksDialog tasks={rootSession.taskSession} stopTask={turn.stopTask} onClose={() => setActivePanel(undefined)}/>
                ) : (activePanel === "sandbox") && !turn.confirmRequest ? (
                    <SandboxDialog status={resources.shellRunner.sandboxStatus}
                        configured={configuredNetworkMode}
                        fullAccess={turn.permissionMode === "full-access"}
                        onSave={async mode => {await saveLocalNetworkMode(resources.cwd, mode); setConfiguredNetworkMode(mode);}}
                        onClose={() => setActivePanel(undefined)}/>
                ) : (activePanel === "mcp") && !turn.confirmRequest ? (
                    <McpDialog manager={resources.mcpManager} getRules={turn.getPermissionRules}
                        onSave={turn.saveMcpToolPolicy} onClose={() => setActivePanel(undefined)}/>
                ) : (activePanel === "skills") && !turn.confirmRequest ? (
                    <SkillsDialog skills={resources.skills} issues={resources.skillIssues}
                        projectDirectory={join(resources.cwd, ".hicode", "skills")}
                        userDirectory={join(resources.storage.hicodeHome, "skills")}
                        onClose={() => setActivePanel(undefined)}/>
                ) : (activePanel === "agents") ? (
                    <AgentsDialog
                        manager={resources.agentDefinitions}
                        authoring={resources.agentAuthoring}
                        catalog={resources.subagents}
                        fastModel={resources.fastModel}
                        onClose={() => setActivePanel(undefined)}
                    />
                ) : (activePanel === "diff") ? (
                    <GitDiffDialog
                        loadDiff={turn.loadGitDiff}
                        onClose={() => setActivePanel(undefined)}
                    />
                ) : turn.confirmRequest ? (
                    turn.confirmRequest.toolName === "ask_user" ? (
                        <AskDialog
                            key={turn.confirmRequest.id}
                            req={turn.confirmRequest}
                            onDone={() => turn.clearConfirmRequest(turn.confirmRequest)}
                        />
                    ) : isElevatedBashRequest(turn.confirmRequest) ? (
                        <ElevatedBashDialog
                            key={turn.confirmRequest.id}
                            req={turn.confirmRequest}
                            onDone={() => turn.clearConfirmRequest(turn.confirmRequest)}
                        />
                    ) : isNetworkAccessRequest(turn.confirmRequest) ? (
                        <NetworkAccessDialog
                            key={turn.confirmRequest.id}
                            req={turn.confirmRequest}
                            onDone={() => turn.clearConfirmRequest(turn.confirmRequest)}
                        />
                    ) : isFileAccessRequest(turn.confirmRequest) ? (
                        <FileAccessDialog
                            key={turn.confirmRequest.id}
                            req={turn.confirmRequest}
                            onDone={() => turn.clearConfirmRequest(turn.confirmRequest)}
                        />
                    ) : (
                        <ConfirmDialog
                            key={turn.confirmRequest.id}
                            req={turn.confirmRequest}
                            onDone={() => turn.clearConfirmRequest(turn.confirmRequest)}
                            onAddToAllowList={turn.handleAddToAllowList}
                        />
                    )
                ) : (
                    <Box marginTop={1} flexDirection="column">
                        {turn.sessionInitializationError && (
                            <Text color={COLORS.error}>
                                Session initialization failed: {turn.sessionInitializationError}
                            </Text>
                        )}
                        <QueuedInputPreview messages={turn.queuedMessages}/>
                        <InputBox
                            fileSuggestions={turn.fileSuggestions}
                            onEscapeHandlerChange={setInputEscapeHandler}
                            persistentHistory={resources.inputHistory}
                            onSubmit={handleSubmit}
                            onPasteImage={turn.pasteImage}
                            imageCount={turn.attachmentState.images.length}
                            imagePreparing={turn.attachmentState.preparing}
                            onRemoveImage={() => turn.removeAttachment("last")}
                            disabled={turn.stopping || turn.attachmentState.preparing}
                            allowEmpty={turn.attachmentState.images.length > 0}
                            cwd={resources.cwd}
                            sessionId={turn.sessionId}
                            startedAt={turn.startedAt}
                            elapsedMs={turn.elapsedMs}
                            replacement={turn.inputReplacement}
                            clearRevision={inputClearRevision}
                            onDraftPresenceChange={setHasInputDraft}
                            takeQueuedInputsForEditing={(state) =>
                                turn.takeQueuedInputsForEditing(
                                    state.value,
                                    state.cursorOffset
                                )}
                        />
                    </Box>
                )}

                <StatusBar
                    showShortcuts={(activePanel !== "diff") && (activePanel !== "skills") && (activePanel !== "sandbox") && (activePanel !== "mcp")}
                    cwd={cwd}
                    model={turn.primaryModel.label}
                    permissionMode={turn.permissionMode}
                    collaborationMode={turn.collaborationMode}
                    tokenCount={turn.tokenInfo.count}
                    percentUsed={turn.tokenInfo.percentUsed}
                    warning={turn.tokenInfo.warning}
                    tokenStatus={turn.tokenInfo.status}
                    mcpConnected={
                        mcpSnapshots.filter((item) => item.status === "connected").length
                    }
                    mcpTotal={
                        mcpSnapshots.filter((item) => item.status !== "disabled").length
                    }
                    sandboxStatus={resources.sandbox.status}
                    backgroundTasks={turn.backgroundTasks}
                />
            </Box></DraftLayoutProvider>
        );
}
