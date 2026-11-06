export {
    createSessionId,
    listSessionIndex,
    loadLatestSession,
    loadSession,
} from "./store/sessionStore.js";

export type {
    LoadedSession,
    SaveSessionSnapshotInput,
    SessionIndexEntry,
} from "./types.js";

export {
    limitPersistedUIEvents,
    SessionUIEventCollector,
} from "./uiEvents.js";

export type {
    PersistedFileChangeUIEvent,
    PersistedUIEvent,
} from "./uiEvents.js";

export type ResumeMode =
    | { kind: "none" }
    | { kind: "picker" }
    | { kind: "session"; sessionId: string }
    | { kind: "continue" };
