import type {FileChange} from "../fileChanges/types.js";
import type {ToolOutcome} from "../toolResults/index.js";

export interface PersistedFileChangeUIEvent {
    version: 1;
    type: "file_change";
    turnId: string;
    toolCallId: string;
    timestamp: string;
    change: FileChange;
}

export interface PersistedToolCallUIEvent {
    version: 1;
    type: "tool_call";
    turnId: string;
    toolCallId: string;
    timestamp: string;
    outcome: ToolOutcome;
}

export type PersistedUIEvent =
    | PersistedFileChangeUIEvent
    | PersistedToolCallUIEvent;

const MAX_PERSISTED_UI_EVENTS = 4_096;
const MAX_PERSISTED_UI_EVENT_BYTES = 20 * 1024 * 1024;

export function limitPersistedUIEvents(
    events: PersistedUIEvent[],
    maxEvents = MAX_PERSISTED_UI_EVENTS,
    maxBytes = MAX_PERSISTED_UI_EVENT_BYTES
): PersistedUIEvent[] {
    const candidates = events.slice(-maxEvents);
    const kept: PersistedUIEvent[] = [];
    let bytes = 0;
    for (const event of [...candidates].reverse()) {
        const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
        if (bytes + eventBytes > maxBytes) continue;
        kept.push(event);
        bytes += eventBytes;
    }
    return kept.reverse();
}
