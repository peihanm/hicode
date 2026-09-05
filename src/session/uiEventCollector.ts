import {toolFileChanges} from "../fileChanges/index.js";
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
        for (const change of toolFileChanges(event.uiData, event.outcome)) {
            const previous = [...this.currentEvents].reverse().find(
                (item): item is PersistedFileChangeUIEvent =>
                    item.type === "file_change" &&
                    item.turnId === event.turnId &&
                    item.change.path === change.path
            );
            const persistedChange = previous
                ? mergeFileChange(
                    [previous.change],
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
            },
        ]);
    }

    getEvents(): readonly PersistedUIEvent[] {
        return this.currentEvents;
    }
}
