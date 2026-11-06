import {toolFileChanges} from "../toolResults/uiData.js";
import type {AgentEvent} from "../agent/types.js";
import {mergeFileChange} from "../fileChanges/index.js";
import type {ShellResultReceipt} from "../tools/bash/receipt.js";
import type {FileReadReceipt} from "../tools/files/receipt.js";
import type {AgentReceipt} from "../tools/agent/receipt.js";
import type {FileChange} from "../fileChanges/index.js";
import type {ToolOutcome} from "../toolResults/index.js";
import type {TaskResultReceipt} from "../tasks/types.js";

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
    shellResult?: ShellResultReceipt;
    completedTask?: TaskResultReceipt;
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

export class SessionUIEventCollector {
    private currentEvents: PersistedUIEvent[] = [];
    private readonly activeToolCalls = new Set<string>();

    constructor(events: readonly PersistedUIEvent[] = []) { this.reset(events); }

    reset(events: readonly PersistedUIEvent[]): void {
        this.currentEvents = limitPersistedUIEvents([...events]);
        this.activeToolCalls.clear();
    }

    handleEvent(event: AgentEvent): void {
        if (event.type === "approval_review" && event.phase === "end") {
            this.currentEvents = limitPersistedUIEvents([...this.currentEvents,
                {...event, phase: "end", reason: event.reason?.slice(0, 4000), version: 1, timestamp: new Date().toISOString()}]);
            return;
        }

        if (event.type === "tool_result_delivery") {
            if (event.status === "failed") this.currentEvents = this.currentEvents.map(item =>
                item.type === "tool_call" && item.toolCallId === event.toolCallId ? {...item, outcome: event.outcome,
                    ...(item.shellResult ? {shellResult: {...item.shellResult, outputFailed: true}} : {})} : item);
            return;
        }
        if (event.type === "tool_call_start") {
            this.activeToolCalls.add(event.toolCallId);
            return;
        }
        if (event.type !== "tool_call_end") return;
        if (!this.activeToolCalls.delete(event.toolCallId)) return;
        for (const change of toolFileChanges(event.uiData, event.outcome)) {
            const previous = this.currentEvents.filter(
                (item): item is PersistedFileChangeUIEvent =>
                    item.type === "file_change" &&
                    item.turnId === event.turnId &&
                    item.change.path === change.path
            );
            const persistedChange = previous.length > 0
                ? mergeFileChange(
                    previous.map(item => item.change),
                    change
                ).at(-1)!
                : change;
            this.currentEvents = limitPersistedUIEvents([
                ...this.currentEvents,
                {
                    version: 1,
                    type: "file_change",
                    turnId: event.turnId,
                    toolCallId: event.toolCallId,
                    timestamp: new Date().toISOString(),
                    change: persistedChange,
                },
            ]);
        }
        this.currentEvents = limitPersistedUIEvents([
            ...this.currentEvents,
            {
                version: 1,
                type: "tool_call",
                turnId: event.turnId,
                toolCallId: event.toolCallId,
                timestamp: new Date().toISOString(),
                outcome: event.outcome ?? "ok",
                ...(event.outcome === "ok" && event.uiData?.type === "file_read" ? {fileRead: event.uiData.receipt} : {}),
                ...(event.outcome === "ok" && event.uiData?.type === "agent_receipt" ? {agentReceipt: event.uiData.receipt} : {}),
                ...(event.uiData?.type === "shell_result" ? {shellResult: event.uiData.receipt} : {}),
                ...(event.completedTask ? {completedTask: event.completedTask} : {}),
            },
        ]);
    }

    getEvents(): readonly PersistedUIEvent[] {
        return this.currentEvents;
    }
}
