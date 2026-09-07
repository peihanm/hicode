import {listRewindPoints} from "../../session/fork.js";
import {type CompactState} from "../../context/index.js";
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
    getPermissionMode,
}: {
    resources: RootRuntimeResources;
    rootSession: RootSessionRuntime;
    eventStore: UITurnEventStore;
    sessionQueue: SessionSnapshotQueue;
    applyRestoredState(state: RestoredCheckpointState): void;
    getPermissionMode(): PermissionMode;
}) {
    const {cwd} = resources;
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
        const history = rootSession.history;
        const compactState = rootSession.compactState;
        applyRestoredState({
            history,
            compactState,
            todos: [...checkpoint.todos],
            permissionMode: getPermissionMode(),
            collaborationMode: checkpoint.collaborationMode,
            uiEvents: checkpoint.uiEvents,
            prompt: checkpoint.prompt,
        });
        return checkpoint;
    };

    return {
        listCheckpoints: () => listRewindPoints({storage: resources.storage, cwd, sessionId: rootSession.sessionId, runtime: fileCheckpoints}),
        async forkConversation(checkpointId: string) {
            await sessionQueue.drain();
            return rootSession.forkConversation(checkpointId, getPermissionMode());
        },
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
            await sessionQueue.drain();
            const result = await rootSession.restoreCheckpoint(checkpointId, getPermissionMode());
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
