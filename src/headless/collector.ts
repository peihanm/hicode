import type {AgentEvent} from "../agent/types.js";
import {SessionUIEventCollector, type PersistedUIEvent,} from "../session/index.js";
import type {HeadlessSubagent, HeadlessToolCall} from "./types.js";

export interface HeadlessCollectorSnapshot {
    toolCalls: HeadlessToolCall[];
    subagents: HeadlessSubagent[];
    currentUIEvents: PersistedUIEvent[];
}

export class HeadlessEventCollector {
    private readonly toolCalls: HeadlessToolCall[] = [];
    private readonly subagents: HeadlessSubagent[] = [];
    private readonly uiEvents = new SessionUIEventCollector();

    handleEvent = (event: AgentEvent): void => {
        this.uiEvents.handleEvent(event);
        switch (event.type) {
            case "tool_call_start":
                this.toolCalls.push({
                    toolCallId: event.toolCallId,
                    name: event.name,
                    args: event.args,
                    outcome: "running",
                });
                break;
            case "tool_call_end": {
                const toolCall = this.toolCalls.find(
                    (call) => call.toolCallId === event.toolCallId
                );
                if (!toolCall) break;
                toolCall.result = event.result;
                toolCall.outcome = event.outcome === "interrupted"
                    ? "interrupted"
                    : event.outcome === "denied"
                        ? "permission_denied"
                        : event.outcome === "failed"
                            ? "failed"
                            : "ok";
                if (event.persisted) toolCall.persisted = event.persisted;
                if (event.uiData) toolCall.uiData = event.uiData;
                break;
            }
            case "tool_result_persisted": {
                const toolCall = this.toolCalls.find(
                    (call) => call.toolCallId === event.toolCallId
                );
                if (toolCall) toolCall.persisted = event.persisted;
                break;
            }
            case "subagent_start":
                this.subagents.push({
                    agentId: event.agentId,
                    agentType: event.agentType,
                    description: event.description,
                    status: "running",
                });
                break;
            case "subagent_end": {
                const subagent = this.subagents.find(
                    (item) => item.agentId === event.agentId
                );
                if (subagent) {
                    subagent.status = event.reason === "interrupted"
                        ? "interrupted"
                        : event.reason === "max_turns" ||
                        event.reason === "permission_denied"
                            ? "failed"
                            : "completed";
                    subagent.reason = event.reason;
                    subagent.iterations = event.iterations;
                    subagent.toolUseCount = event.toolUseCount;
                    subagent.durationMs = event.durationMs;
                    if (event.transcriptPath) {
                        subagent.transcriptPath = event.transcriptPath;
                    }
                }
                break;
            }
            case "subagent_error": {
                const subagent = this.subagents.find(
                    (item) => item.agentId === event.agentId
                );
                if (subagent) {
                    subagent.status = "failed";
                    subagent.error = event.message;
                }
                break;
            }
            default:
                break;
        }
    };

    getSnapshot(): HeadlessCollectorSnapshot {
        return {
            toolCalls: this.toolCalls.map((toolCall) => ({...toolCall})),
            subagents: this.subagents.map((subagent) => ({...subagent})),
            currentUIEvents: [...this.uiEvents.getEvents()],
        };
    }
}
