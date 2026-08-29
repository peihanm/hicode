export {
    createSessionId,
    listSessionIndex,
    loadLatestSession,
    loadSession,
    saveSessionSnapshot,
    saveSessionTurnCheckpoint,
    listSessionTurnCheckpoints,
    loadSessionTurnCheckpoint,
} from "./storage.js";

export type {
    LoadedSession,
    SaveSessionSnapshotInput,
    SessionTurnCheckpointEntry,
    SessionIndexEntry,
} from "./types.js";

export {
    limitPersistedUIEvents,
} from "./uiEvents.js";

export type {
    PersistedFileChangeUIEvent,
    PersistedToolCallUIEvent,
    PersistedUIEvent,
} from "./uiEvents.js";

export type ResumeMode =
    | { kind: "none" }
    | { kind: "picker" }
    | { kind: "session"; sessionId: string }
    | { kind: "continue" };
