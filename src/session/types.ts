import type {CompactState} from "../context/index.js";
import type {CheckpointHead} from "../checkpoints/index.js";
import type {PersistedUIEvent} from "./uiEvents.js";
import type {GitSessionState} from "../git/index.js";
import type {Message} from "../llm/types.js";
import type {PermissionMode} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {RuntimeQueuedMessage} from "../runtime/messageQueue.js";
import type {Todo} from "../todos.js";
import type {ToolDiscoverySnapshot} from "../tools/registry.js";

export const SESSION_INDEX_VERSION = 1;
export const SESSION_ENTRY_VERSION = 3;

export interface SessionIndexEntry {
    sessionId: string;
    cwd: string;
    model: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    firstPrompt?: string;
    lastPrompt?: string;
    summary?: string;
    archived?: boolean;
}

export interface SessionIndexFile {
    version: number;
    sessions: SessionIndexEntry[];
}

export interface SessionSnapshotEntry {
    type: "snapshot";
    version: 3;
    sessionId: string;
    cwd: string;
    model: string;
    timestamp: string;
    conversation: Message[];
    todos: Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    compactState?: CompactState;
    uiEvents: PersistedUIEvent[];
    checkpointHead?: CheckpointHead;
    queuedInputs?: RuntimeQueuedMessage[];
    toolDiscovery?: ToolDiscoverySnapshot;
    gitSession?: GitSessionState;
}

export interface SessionTurnCheckpointEntry {
    type: "turn_checkpoint";
    version: 3;
    checkpointId: string;
    sessionId: string;
    branchId: string;
    parentCheckpointId?: string;
    cwd: string;
    model: string;
    timestamp: string;
    prompt: string;
    conversation: Message[];
    todos: Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    compactState?: CompactState;
    uiEvents: PersistedUIEvent[];
    toolDiscovery?: ToolDiscoverySnapshot;
}

export type SessionEntry = SessionSnapshotEntry | SessionTurnCheckpointEntry;

export interface LoadedSession {
    sessionId: string;
    cwd: string;
    model: string;
    history: Message[];
    todos: Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    compactState?: CompactState;
    uiEvents: PersistedUIEvent[];
    checkpointHead?: CheckpointHead;
    queuedInputs: RuntimeQueuedMessage[];
    toolDiscovery?: ToolDiscoverySnapshot;
    gitSession?: GitSessionState;
    index?: SessionIndexEntry;
}

export interface SaveSessionSnapshotInput {
    cwd: string;
    model: string;
    sessionId: string;
    history: Message[];
    todos: Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    compactState?: CompactState;
    uiEvents?: PersistedUIEvent[];
    checkpointHead?: CheckpointHead;
    queuedInputs?: readonly RuntimeQueuedMessage[];
    toolDiscovery?: ToolDiscoverySnapshot;
    gitSession?: GitSessionState;
    /** Rewind 到首条问题之前时允许保存空 conversation。 */
    allowEmpty?: boolean;
    /** 空 conversation 的 Session index 标题。 */
    summaryHint?: string;
}

export interface SaveSessionTurnCheckpointInput {
    cwd: string;
    model: string;
    sessionId: string;
    checkpointId: string;
    branchId: string;
    parentCheckpointId?: string;
    prompt: string;
    history: Message[];
    todos: Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    compactState?: CompactState;
    uiEvents?: PersistedUIEvent[];
    toolDiscovery?: ToolDiscoverySnapshot;
}
