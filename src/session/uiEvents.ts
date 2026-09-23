import type {FileReadReceipt} from "../tools/readFile/receipt.js";
import type {AgentReceipt} from "../tools/agent/receipt.js";
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

interface PersistedToolCallUIEvent {
    version: 1;
    type: "tool_call";
    turnId: string;
    toolCallId: string;
    timestamp: string;
    outcome: ToolOutcome;
    agentReceipt?: AgentReceipt;
    fileRead?: FileReadReceipt;
}

export type PersistedUIEvent =
    | (import("../permissions/approval.js").ApprovalEvent & {phase: "end"; version: 1; timestamp: string})
    | PersistedFileChangeUIEvent
    | PersistedToolCallUIEvent;

const MAX_PERSISTED_UI_EVENTS = 4_096;
const MAX_PERSISTED_UI_EVENT_BYTES = 20 * 1024 * 1024;

export function limitPersistedUIEvents(
    events: PersistedUIEvent[],
    maxEvents = MAX_PERSISTED_UI_EVENTS,
    maxBytes = MAX_PERSISTED_UI_EVENT_BYTES,
    measure: (event: PersistedUIEvent) => number = event => Buffer.byteLength(JSON.stringify(event), "utf8")
): PersistedUIEvent[] {
    const supersededNetChanges = new Set<string>();
    const compacted: PersistedUIEvent[] = [];
    for (const event of [...events].reverse()) {
        if (event.type !== "file_change") {
            compacted.push(event);
            continue;
        }
        const key = `${event.turnId}\u0000${event.change.path}`;
        if (supersededNetChanges.has(key)) continue;
        compacted.push(event);
        if (event.change.scope === "turn") supersededNetChanges.add(key);
    }
    const candidates = compacted.reverse().slice(-maxEvents);
    const kept: PersistedUIEvent[] = [];
    let bytes = 0;
    for (const event of [...candidates].reverse()) {
        const eventBytes = measure(event);
        if (bytes + eventBytes > maxBytes) continue;
        kept.push(event);
        bytes += eventBytes;
    }
    return kept.reverse();
}
