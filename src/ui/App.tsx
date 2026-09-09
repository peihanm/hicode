import type {MessageContent} from "../images/content.js";
import {AssistantDraftView} from "./conversation/AssistantDraftView.js";
import {useRef, useCallback, useEffect, useState, type ReactNode} from "react";
import {Box, Text, useApp, useInput} from "ink";
import {listSessionIndex, type LoadedSession, type SessionIndexEntry,} from "../session/index.js";
import type {PermissionMode} from "../permissions/index.js";
import {getNextCollaborationMode, type CollaborationMode} from "../collaboration/index.js";
import type {RootRuntimeResources} from "../runtime/resources.js";
import {MessageList, TranscriptDetails,} from "./conversation/MessageList.js";
import {ScrollbackTranscript} from "./conversation/ScrollbackTranscript.js";
import {InputBox} from "./input/InputBox.js";
import {ConfirmDialog} from "./dialogs/ConfirmDialog.js";
import {
    FileAccessDialog,
    isFileAccessRequest,
} from "./dialogs/FileAccessDialog.js";
import {isNetworkAccessRequest, NetworkAccessDialog} from "./dialogs/NetworkAccessDialog.js";
import {ElevatedBashDialog, isElevatedBashRequest,} from "./dialogs/ElevatedBashDialog.js";
import {EnterPlanDialog} from "./dialogs/EnterPlanDialog.js";
import {AskDialog} from "./dialogs/AskDialog.js";
import {PlanApprovalDialog} from "./dialogs/PlanApprovalDialog.js";
import {PermissionsDialog} from "./dialogs/PermissionsDialog.js";
import {StatusBar} from "./status/StatusBar.js";
import {TodoList} from "./status/TodoList.js";
import {ModelStreamStatus} from "./status/ModelStreamStatus.js";
import {useTurnController} from "./turn/useTurnController.js";
import type {UIThread} from "./conversation/types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import {RewindDialog} from "./rewind/RewindDialog.js";
import {GitDiffDialog} from "./git/GitDiffDialog.js";
import {AgentsDialog} from "./agents/AgentsDialog.js";
import {QueuedInputPreview} from "./input/QueuedInputPreview.js";
import {ModelDialog} from "./model/ModelDialog.js";
import {COLORS} from "./theme.js";
import type {RootSessionRuntime} from "../runtime/sessionRuntime.js";
import {ResumeDialog} from "./resume/ResumeDialog.js";

function runningActivityLabel(
    threads: UIThread[],
    subagents: SubagentRegistry
): string | undefined {
    const hook = [...threads].reverse().find(thread => thread.role === "hook" && thread.status === "running");
    if (hook?.role === "hook") return `正在执行 Hook ${hook.execution.event}...`;
    const running = [...threads].reverse().find(
        (thread): thread is Extract<UIThread, { role: "tool_call" }> =>
            thread.role === "tool_call" && thread.status === "running"
    );
    if (!running) return undefined;
    if (running.name !== "agent") return `正在执行 ${running.name}...`;

    let agentType = running.subagentType;
    if (!agentType) {
        try {
            const parsed = JSON.parse(running.args) as Record<string, unknown>;
            if (
                typeof parsed.subagent_type === "string" &&
                subagents.has(parsed.subagent_type)
            ) {
                agentType = parsed.subagent_type;
            }
        } catch {
            // 非法参数最终会由工具层报告；状态行退回通用 Agent 名称。
        }
    }
    let forkName: string | undefined;
    try {
        const parsed = JSON.parse(running.args) as Record<string, unknown>;
        if (parsed.subagent_type === "fork" && typeof parsed.name === "string") {
            forkName = `${parsed.name} (fork)`;
        }
    } catch {
        // 非法参数最终会由工具层报告。
    }
    return `正在运行 ${forkName ?? agentType ?? "Agent"} Agent...`;
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
        const [showResume, setShowResume] = useState(false);
        const [resumeSessions, setResumeSessions] = useState<SessionIndexEntry[]>([]);
        const [showRewind, setShowRewind] = useState(false);
        const [showAgents, setShowAgents] = useState(false);
        const [showGitDiff, setShowGitDiff] = useState(false);
        const [showModel, setShowModel] = useState(false);
        const [showPermissions, setShowPermissions] = useState(false);
        const openResume = useCallback(() => {
            setShowRewind(false);
            setShowAgents(false);
            setShowGitDiff(false);
            setShowModel(false);
            setShowPermissions(false);
            setResumeSessions(listSessionIndex(resources.storage, resources.cwd));
            setShowResume(true);
        }, [resources.cwd, resources.storage]);
        const openRewind = useCallback(() => {
            setShowResume(false);
            setShowAgents(false);
            setShowGitDiff(false);
            setShowModel(false);
            setShowPermissions(false);
            setShowRewind(true);
        }, []);
        const openAgents = useCallback(() => {
            setShowResume(false);
            setShowRewind(false);
            setShowGitDiff(false);
            setShowModel(false);
            setShowPermissions(false);
            setShowAgents(true);
        }, []);
        const openGitDiff = useCallback(() => {
            setShowResume(false);
            setShowRewind(false);
            setShowAgents(false);
            setShowModel(false);
            setShowPermissions(false);
            setShowGitDiff(true);
        }, []);
        const openModel = useCallback(() => {
            setShowResume(false);
            setShowRewind(false);
            setShowAgents(false);
            setShowGitDiff(false);
            setShowPermissions(false);
            setShowModel(true);
        }, []);
        const openPermissions = useCallback(() => {
            setShowResume(false);
            setShowRewind(false);
            setShowAgents(false);
            setShowGitDiff(false);
            setShowModel(false);
            setShowPermissions(true);
        }, []);
        const turn = useTurnController({
            resources,
            initialPermissionMode,
            initialCollaborationMode,
            initialSession,
            rootSession,
            resumedDraft,
            openResume: requestSessionSwitch ? openResume : undefined,
            openRewind,
            openAgents,
            openGitDiff,
            openModel,
            openPermissions,
        });
        const initialImagesLoaded = useRef(false);
        useEffect(() => {
            if (initialImagesLoaded.current || !initialImages?.length) return;
            initialImagesLoaded.current = true;
            void turn.addImages(initialImages);
        }, [initialImages, turn]);
        const [showTodos, setShowTodos] = useState(true);
        const [showTranscript, setShowTranscript] = useState(false);
        const [hasInputDraft, setHasInputDraft] = useState(false);
        const [inputClearRevision, setInputClearRevision] = useState(0);
        useEffect(() => {
            registerSessionShutdown?.(turn.shutdown);
        }, [registerSessionShutdown, turn.shutdown]);
        const requestExit = useCallback(() => {
            // 先同步触发后台任务 abort，避免 CLI 的有界强制退出留下 detached 进程。
            resources.beginShutdown();
            exit();
        }, [exit, resources]);

        const handleSubmit = useCallback(
            async (input: string) => {
                if (input === "exit" || input === "quit") {
                    requestExit();
                    return;
                }
                if (await turn.attachmentCommand(input)) return;
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
            if (showResume || showRewind || showAgents || showGitDiff || showModel || showPermissions) return;
            const isCancel = key.escape || input === "\u001B" || isCtrlC;
            const planDialogHandlesEscape =
                turn.confirmRequest?.toolName === "exit_plan_mode" &&
                !isCtrlC &&
                (key.escape || input === "\u001B");
            if (
                (turn.busy || turn.attachmentState.preparing) &&
                isCancel &&
                !planDialogHandlesEscape
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
            if (key.ctrl && input === "t") {
                setShowTodos((previous) => !previous);
                return;
            }
            if (key.ctrl && input === "o") {
                setShowTranscript((previous) => !previous);
            }
        });

        const {cwd, mcpManager} = resources;
        const mcpSnapshots = mcpManager?.getSnapshots() ?? [];
        const activityLabel = runningActivityLabel(
            turn.liveThreads,
            resources.subagents
        );
        return (
            <Box flexDirection="column">
                <ScrollbackTranscript threads={turn.staticThreads} showWelcome/>

                <MessageList
                    threads={showTranscript ? [] : turn.liveThreads}
                    paused={!!turn.confirmRequest}
                />

                {showTranscript && (
                    <TranscriptDetails threads={turn.threads}/>
                )}

                {showTodos && !showResume && !showRewind && !showAgents && !showGitDiff && !showModel && !showPermissions && (
                    <TodoList
                        todos={turn.todos}
                        paused={!turn.busy || !!turn.confirmRequest}
                    />
                )}

                {turn.busy && !turn.confirmRequest && !showResume && !showRewind && !showAgents && !showGitDiff && !showModel && !showPermissions && (
                    <>
                        <AssistantDraftView store={turn.draftStore}/>
                        <ModelStreamStatus
                            modelStream={turn.modelStream}
                            progressRef={turn.modelStreamProgressRef}
                            stopping={turn.stopping}
                            activityLabel={activityLabel}
                        />
                    </>
                )}

                {runtimeApproval ? runtimeApproval : showResume && requestSessionSwitch ? (
                    <ResumeDialog
                        sessions={resumeSessions}
                        currentSessionId={turn.sessionId}
                        onSelect={requestSessionSwitch}
                        onClose={() => setShowResume(false)}
                    />
                ) : showModel ? (
                    <ModelDialog
                        models={turn.availableModels}
                        current={turn.primaryModel}
                        onSelect={(target) => {
                            turn.setPrimaryModel(target);
                            setShowModel(false);
                        }}
                        onClose={() => setShowModel(false)}
                    />
                ) : showPermissions ? (
                    <PermissionsDialog
                        current={turn.permissionMode}
                        onSelect={(mode) => {
                            turn.setPermissionMode(mode);
                            setShowPermissions(false);
                        }}
                        onClose={() => setShowPermissions(false)}
                    />
                ) : showAgents ? (
                    <AgentsDialog
                        manager={resources.agentDefinitions}
                        authoring={resources.agentAuthoring}
                        catalog={resources.subagents}
                        fastModel={resources.fastModel}
                        onClose={() => setShowAgents(false)}
                    />
                ) : showGitDiff ? (
                    <GitDiffDialog
                        loadDiff={turn.loadGitDiff}
                        listFileChangeEvents={turn.listFileChangeEvents}
                        onClose={() => setShowGitDiff(false)}
                    />
                ) : showRewind ? (
                    <RewindDialog
                        listCheckpoints={turn.listCheckpoints}
                        previewCheckpoint={turn.previewCheckpoint}
                        restoreCheckpoint={turn.restoreCheckpoint}
                        forkConversation={requestSessionSwitch ? async (checkpointId) => {
                            const fork = await turn.forkConversation(checkpointId);
                            await requestSessionSwitch(fork.sessionId);
                        } : undefined}
                        onClose={() => setShowRewind(false)}
                    />
                ) : turn.confirmRequest ? (
                    turn.confirmRequest.toolName === "ask_user" ? (
                        <AskDialog
                            key={turn.confirmRequest.id}
                            req={turn.confirmRequest}
                            onDone={() => turn.clearConfirmRequest(turn.confirmRequest)}
                        />
                    ) : turn.confirmRequest.toolName === "exit_plan_mode" ? (
                        <PlanApprovalDialog
                            key={turn.confirmRequest.id}
                            req={turn.confirmRequest}
                            onDone={() => turn.clearConfirmRequest(turn.confirmRequest)}
                        />
                    ) : turn.confirmRequest.toolName === "enter_plan_mode" ? (
                        <EnterPlanDialog
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
                                Session 初始化失败：{turn.sessionInitializationError}
                            </Text>
                        )}
                        <QueuedInputPreview messages={turn.queuedMessages}/>
                        <InputBox
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
            </Box>
        );
}
