import type {CompactState} from "../context/index.js";
import type {PersistedUIEvent} from "./uiEvents.js";
import type {GitSessionState} from "../git/index.js";
import type {Message} from "../llm/types.js";
import type {PermissionMode} from "../permissions/index.js";
import type {CollaborationMode} from "../collaboration/index.js";
import type {RuntimeQueuedMessage} from "../runtime/messageQueue.js";
import type {Todo} from "../todos.js";
import type {ToolDiscoverySnapshot} from "../tools/registry.js";

export const SESSION_INDEX_VERSION = 1;
export const SESSION_ENTRY_VERSION = 6;

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
    version: typeof SESSION_ENTRY_VERSION;
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
    queuedInputs?: RuntimeQueuedMessage[];
    taskNotificationReceipts?: string[];
    toolDiscovery?: ToolDiscoverySnapshot;
    gitSession?: GitSessionState;
}


export type SessionEntry = SessionSnapshotEntry;

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
    queuedInputs: RuntimeQueuedMessage[];
    taskNotificationReceipts: string[];
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
    queuedInputs?: readonly RuntimeQueuedMessage[];
    taskNotificationReceipts?: readonly string[];
    toolDiscovery?: ToolDiscoverySnapshot;
    gitSession?: GitSessionState;
    /** 允许保存尚无完整回复的会话。 */
    allowEmpty?: boolean;
    /** 空 conversation 的 Session index 标题。 */
    summaryHint?: string;
}
