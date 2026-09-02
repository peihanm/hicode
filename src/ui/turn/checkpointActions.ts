import {createCompactState, type CompactState} from "../../context/index.js";
import {createInitialHistory} from "../../prompt/index.js";
import type {PermissionMode} from "../../permissions/index.js";
import type {CollaborationMode} from "../../collaboration/index.js";
import type {RootRuntimeResources} from "../../runtime/resources.js";
import type {RootSessionRuntime} from "../../runtime/sessionRuntime.js";
import {
    loadSessionTurnCheckpoint,
    type PersistedUIEvent,
} from "../../session/index.js";
import type {Todo} from "../../todos.js";
import type {Message} from "../../llm/types.js";
import type {UITurnEventStore} from "./eventStore.js";
import type {SessionSnapshotQueue} from "./sessionQueue.js";

interface RestoredCheckpointState {
    history: Message[];
    compactState: CompactState;
    todos: Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    uiEvents: PersistedUIEvent[];
    prompt: string;
}

export function createUICheckpointActions({
    resources,
    rootSession,
    eventStore,
    sessionQueue,
    applyRestoredState,
}: {
    resources: RootRuntimeResources;
    rootSession: RootSessionRuntime;
    eventStore: UITurnEventStore;
    sessionQueue: SessionSnapshotQueue;
    applyRestoredState(state: RestoredCheckpointState): void;
}) {
    const {cwd, toolRuntime} = resources;
    const {fileCheckpoints, gitSession} = rootSession;

    const restoreConversation = async (checkpointId: string) => {
        const checkpoint = loadSessionTurnCheckpoint(
            resources.storage,
            cwd,
            rootSession.sessionId,
            checkpointId
        );
        if (!checkpoint) {
            throw new Error(`找不到对话 Checkpoint: ${checkpointId}`);
        }
        const currentModel = resources.model;
        const history = [
            ...createInitialHistory(cwd, currentModel),
            ...checkpoint.conversation,
        ];
        const compactState = checkpoint.compactState
            ? {...checkpoint.compactState}
            : createCompactState();
        const previousToolDiscovery = toolRuntime.getToolDiscoverySnapshot();
        toolRuntime.restoreToolDiscovery(checkpoint.toolDiscovery);
        try {
            await sessionQueue.enqueueCritical({
                cwd,
                model: currentModel,
                sessionId: rootSession.sessionId,
                history,
                todos: checkpoint.todos,
                permissionMode: checkpoint.permissionMode,
                collaborationMode: checkpoint.collaborationMode,
                compactState,
                uiEvents: checkpoint.uiEvents,
                toolDiscovery: toolRuntime.getToolDiscoverySnapshot(),
                gitSession: gitSession.getState(),
                checkpointHead: fileCheckpoints.getHead(),
                allowEmpty: true,
                summaryHint: checkpoint.prompt,
            });
        } catch (error) {
            toolRuntime.restoreToolDiscovery(previousToolDiscovery);
            throw error;
        }
        rootSession.replaceConversation(history, compactState);
        applyRestoredState({
            history,
            compactState,
            todos: [...checkpoint.todos],
            permissionMode: checkpoint.permissionMode,
            collaborationMode: checkpoint.collaborationMode,
            uiEvents: checkpoint.uiEvents,
            prompt: checkpoint.prompt,
        });
        return checkpoint;
    };

    return {
        listCheckpoints: () => fileCheckpoints.listCheckpoints(),
        listFileChangeEvents: () => eventStore.getPersistedUIEvents(),
        previewCheckpoint: (checkpointId: string) =>
            fileCheckpoints.previewRestore(checkpointId),
        loadGitDiff: (signal: AbortSignal) => gitSession.diff(signal),
        async restoreCheckpoint(checkpointId: string) {
            if (resources.taskRuntime.hasRunningThatBlocksRewind()) {
                throw new Error(
                    "仍有会读取当前工作区的后台 Task 运行，请先停止后再恢复代码"
                );
            }
            const result = await fileCheckpoints.restoreCode(checkpointId);
            if (result.restoredFiles.length > 0) {
                gitSession.observePaths(result.restoredFiles, cwd);
            }
            if (result.status !== "complete") return result;
            try {
                await restoreConversation(checkpointId);
                return result;
            } catch (error) {
                return {
                    ...result,
                    status: "partial" as const,
                    failures: [{
                        path: "<conversation>",
                        message: error instanceof Error
                            ? error.message
                            : String(error),
                    }],
                };
            }
        },
    };
}
