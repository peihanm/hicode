import type {AgentEvent} from "../agent/types.js";
import {mergeFileChange} from "../fileChanges/index.js";
import {
    limitPersistedUIEvents,
    type PersistedFileChangeUIEvent,
    type PersistedUIEvent,
} from "./uiEvents.js";

export class SessionUIEventCollector {
    private currentEvents: PersistedUIEvent[] = [];
    private readonly activeToolCalls = new Set<string>();

    handleEvent(event: AgentEvent): void {
        if (event.type === "tool_call_start") {
            this.activeToolCalls.add(event.toolCallId);
            return;
        }
        if (event.type !== "tool_call_end") return;
        if (!this.activeToolCalls.delete(event.toolCallId)) return;
        if (
            event.outcome === "ok" &&
            event.turnId &&
            event.uiData?.type === "file_change"
        ) {
            const previous = [...this.currentEvents].reverse().find(
                (item): item is PersistedFileChangeUIEvent =>
                    item.type === "file_change" &&
                    item.turnId === event.turnId &&
                    item.change.path === event.uiData!.change.path
            );
            const persistedChange = previous
                ? mergeFileChange(
                    [previous.change],
                    event.uiData.change
                ).at(-1)!
                : event.uiData.change;
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
            },
        ]);
    }

    getEvents(): readonly PersistedUIEvent[] {
        return this.currentEvents;
    }
}
