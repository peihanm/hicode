export {
    createSessionId,
    listSessionIndex,
    loadLatestSession,
    loadSession,
} from "./storage.js";

export type {
    LoadedSession,
    SaveSessionSnapshotInput,
    SessionIndexEntry,
} from "./types.js";

export {
    limitPersistedUIEvents,
} from "./uiEvents.js";

export {SessionUIEventCollector} from "./uiEventCollector.js";

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
