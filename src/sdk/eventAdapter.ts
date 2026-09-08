import {toolFileChanges} from "../fileChanges/index.js";
import type {AgentEvent, StopReason} from "../agent/types.js";
import {SessionUIEventCollector} from "../session/index.js";
import type {
    CompactItem,
    DiagnosticItem,
    FileChangeItem,
    HookItem,
    InteractionItem,
    InteractionRequest,
    InteractionResponse,
    MemoryChangeItem,
    SubagentItem,
    ThreadEventPayload,
    ThreadItem,
    TodoListItem,
    ToolCallItem,
} from "./protocol.js";
import type {Todo} from "../todos.js";

const ITEM_TEXT_LIMIT = 10_000;

function boundedText(value: string): string {
    return value.length <= ITEM_TEXT_LIMIT
        ? value
        : `${value.slice(0, ITEM_TEXT_LIMIT - 1)}…`;
}

function parseArguments(value: string): unknown {
    if (value.length > ITEM_TEXT_LIMIT) {
        return {
            raw: boundedText(value),
            truncated: true,
        };
    }
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return {raw: boundedText(value)};
    }
}

function toolCategory(name: string): ToolCallItem["category"] {
    if (name.startsWith("mcp__")) return "mcp";
    if (name === "bash" || name.endsWith("_task")) return "command";
    return "builtin";
}

function terminalToolStatus(
    outcome: ToolCallItem["outcome"]
): ToolCallItem["status"] {
    switch (outcome) {
        case "failed":
            return "failed";
        case "denied":
            return "denied";
        case "interrupted":
            return "interrupted";
        default:
            return "completed";
    }
}

type EmitPayload = (event: ThreadEventPayload) => void | Promise<void>;

export class SDKEventAdapter {
    private readonly uiEvents = new SessionUIEventCollector();
    private readonly tools = new Map<string, ToolCallItem>();
    private readonly endedTools = new Set<string>();
    private readonly activeHooks = new Set<string>();
    private readonly fileChanges = new Map<string, FileChangeItem[]>();
    private readonly subagents = new Map<string, SubagentItem>();
    private activeCompact: CompactItem | undefined;
    private itemSequence = 0;
    private lastProgress:
        | {phase: string; estimatedOutputTokens: number}
        | undefined;

    constructor(
        private readonly turnId: string,
        private readonly emit: EmitPayload
    ) {}

    handleAgentEvent = async (event: AgentEvent): Promise<void> => {
        this.uiEvents.handleEvent(event);
        switch (event.type) {
            case "hook_started":
            case "hook_completed": {
                const execution = {...event.execution, handler: boundedText(event.execution.handler)};
                const item: HookItem = {
                    id: `hook:${execution.executionId}`, type: "hook",
                    status: event.type === "hook_started" ? "in_progress" : event.execution.outcome === "interrupted" ? "interrupted"
                        : event.execution.outcome === "error" || event.execution.outcome === "skipped_budget" ? "failed" : "completed",
                    execution,
                };
                if (event.type === "hook_started") {
                    this.activeHooks.add(item.id);
                    await this.emitItem("item.started", item);
                } else if (this.activeHooks.delete(item.id)) {
                    await this.emitItem("item.completed", item);
                } else {
                    // Skipped handlers have a terminal fact but never started execution.
                    await this.emitInstant(item);
                }
                break;
            }
            case "turn_end":
                await this.emit({type: "turn.settled", turnId: this.turnId, input: event.input});
                break;
            case "assistant_draft":
                await this.emit({type: "turn.draft", turnId: this.turnId, responseId: event.responseId, text: event.text, truncated: event.truncated});
                break;
            case "assistant_draft_end":
                await this.emit({type: "turn.draft_end", turnId: this.turnId, responseId: event.responseId, disposition: event.disposition});
                break;
            case "model_stream_start":
                await this.flushEndedTools();
                this.lastProgress = undefined;
                await this.emit({
                    type: "turn.progress",
                    turnId: this.turnId,
                    phase: "model_waiting",
                    outputCharacters: 0,
                    estimatedOutputTokens: 0,
                });
                break;
            case "model_stream_progress":
                if (!this.shouldEmitProgress(
                    event.phase,
                    event.estimatedOutputTokens
                )) {
                    break;
                }
                this.lastProgress = {
                    phase: event.phase,
                    estimatedOutputTokens: event.estimatedOutputTokens,
                };
                await this.emit({
                    type: "turn.progress",
                    turnId: this.turnId,
                    phase: event.phase,
                    outputCharacters: event.outputCharacters,
                    estimatedOutputTokens: event.estimatedOutputTokens,
                    toolName: event.toolName,
                    idleMilliseconds: event.idleMilliseconds,
                    ...(event.retry ? {retry: event.retry} : {}),
                });
                break;
            case "assistant_text":
                await this.flushEndedTools();
                await this.emitInstant({
                    id: this.nextId("assistant"),
                    type: "agent_message",
                    status: "completed",
                    text: event.content,
                    phase: event.phase ?? "final",
                    ...(event.responseId ? {responseId: event.responseId} : {}),
                });
                break;
            case "tool_call_start": {
                const item: ToolCallItem = {
                    id: `tool:${event.toolCallId}`,
                    type: "tool_call",
                    status: "in_progress",
                    toolCallId: event.toolCallId,
                    name: event.name,
                    category: toolCategory(event.name),
                    arguments: parseArguments(event.args),
                };
                this.tools.set(event.toolCallId, item);
                await this.emitItem("item.started", item);
                break;
            }
            case "tool_call_end": {
                const current = this.tools.get(event.toolCallId);
                if (!current) break;
                const outcome = event.outcome ?? "ok";
                const item: ToolCallItem = {
                    ...current,
                    resultPreview: boundedText(event.result),
                    outcome,
                    ...(event.persisted
                        ? {
                            resultId: event.persisted.resultId,
                            resultByteLength: event.persisted.byteLength,
                            resultComplete: event.persisted.complete,
                        }
                        : {}),
                };
                this.tools.set(event.toolCallId, item);
                this.endedTools.add(event.toolCallId);
                await this.emitItem("item.updated", item);
                const changes = toolFileChanges(event.uiData, event.outcome);
                if (changes.length) {
                    const fileItem: FileChangeItem = {
                        id: this.nextId("file-change"),
                        type: "file_change",
                        status: "completed",
                        parentToolCallId: event.toolCallId,
                        changes: [...changes],
                    };
                    const pending = this.fileChanges.get(event.toolCallId) ?? [];
                    pending.push(fileItem);
                    this.fileChanges.set(event.toolCallId, pending);
                }
                break;
            }
            case "tool_result_persisted": {
                const current = this.tools.get(event.toolCallId);
                if (!current) break;
                const item: ToolCallItem = {
                    ...current,
                    resultId: event.persisted.resultId,
                    resultByteLength: event.persisted.byteLength,
                    resultComplete: event.persisted.complete,
                };
                this.tools.set(event.toolCallId, item);
                await this.emitItem("item.updated", item);
                break;
            }
            case "compact_start": {
                const item: CompactItem = {
                    id: this.nextId("compact"),
                    type: "compact",
                    status: "in_progress",
                    trigger: event.trigger,
                    preTokenCount: event.tokenCount,
                    threshold: event.threshold,
                };
                this.activeCompact = item;
                await this.emitItem("item.started", item);
                break;
            }
            case "compact_end": {
                const current = this.activeCompact;
                if (!current) break;
                const item: CompactItem = {
                    ...current,
                    status: "completed",
                    preTokenCount: event.preTokenCount,
                    postTokenCount: event.postTokenCount,
                };
                this.activeCompact = undefined;
                await this.emitItem("item.completed", item);
                break;
            }
            case "compact_error": {
                const current = this.activeCompact;
                if (!current) break;
                const item: CompactItem = {
                    ...current,
                    status: "failed",
                    error: boundedText(event.message),
                };
                this.activeCompact = undefined;
                await this.emitItem("item.completed", item);
                break;
            }
            case "subagent_start": {
                const item: SubagentItem = {
                    id: `subagent:${event.agentId}`,
                    type: "subagent",
                    status: "in_progress",
                    agentId: event.agentId,
                    agentType: event.agentType,
                    agentName: event.agentName,
                    description: event.description,
                    parentToolCallId: event.parentToolCallId,
                };
                this.subagents.set(event.agentId, item);
                await this.emitItem("item.started", item);
                break;
            }
            case "subagent_end": {
                const current = this.subagents.get(event.agentId);
                if (!current) break;
                const item: SubagentItem = {
                    ...current,
                    status: event.reason === "interrupted"
                        ? "interrupted"
                        : event.reason === "completed" ||
                          event.reason === "no_tool_calls"
                            ? "completed"
                            : "failed",
                    reason: event.reason,
                    iterations: event.iterations,
                    toolUseCount: event.toolUseCount,
                    durationMs: event.durationMs,
                    reportPreview: boundedText(event.report),
                    transcriptPath: event.transcriptPath,
                };
                this.subagents.delete(event.agentId);
                await this.emitItem("item.completed", item);
                break;
            }
            case "subagent_error": {
                const current = this.subagents.get(event.agentId);
                if (!current) break;
                const item: SubagentItem = {
                    ...current,
                    status: "failed",
                    error: boundedText(event.message),
                };
                this.subagents.delete(event.agentId);
                await this.emitItem("item.completed", item);
                break;
            }
            case "memory_update": {
                const item: MemoryChangeItem = {
                    id: this.nextId("memory"),
                    type: "memory_change",
                    status: "completed",
                    source: event.source,
                    changes: event.changes,
                };
                await this.emitInstant(item);
                break;
            }
            default:
                break;
        }
    };

    async emitInteractionStart(request: InteractionRequest): Promise<void> {
        const item: InteractionItem = {
            id: `interaction:${request.requestId}`,
            type: "interaction",
            status: "in_progress",
            request,
        };
        await this.emitItem("item.started", item);
    }

    async emitInteractionEnd(
        request: InteractionRequest,
        response: InteractionResponse,
        status: InteractionItem["status"]
    ): Promise<void> {
        const item: InteractionItem = {
            id: `interaction:${request.requestId}`,
            type: "interaction",
            status,
            request,
            resolution: response.behavior === "allow"
                ? {behavior: "allow"}
                : {behavior: "deny", message: boundedText(response.message)},
        };
        await this.emitItem("item.completed", item);
    }

    async emitTodos(todos: readonly Todo[]): Promise<void> {
        const item: TodoListItem = {
            id: this.nextId("todos"),
            type: "todo_list",
            status: "completed",
            todos: todos.map((todo) => ({...todo})),
        };
        await this.emitInstant(item);
    }

    async emitDiagnostic(
        scope: string,
        message: string,
        severity: DiagnosticItem["severity"] = "warning"
    ): Promise<void> {
        const item: DiagnosticItem = {
            id: this.nextId("diagnostic"),
            type: "diagnostic",
            status: severity === "error" ? "failed" : "completed",
            severity,
            scope,
            message: boundedText(message),
        };
        await this.emitInstant(item);
    }

    async finish(reason: StopReason): Promise<void> {
        await this.flushEndedTools();
        const danglingStatus = reason === "interrupted"
            ? "interrupted"
            : "failed";
        for (const [toolCallId, current] of this.tools) {
            await this.emitItem("item.completed", {
                ...current,
                status: danglingStatus,
                outcome: reason === "interrupted" ? "interrupted" : "failed",
            });
            this.tools.delete(toolCallId);
        }
        for (const [agentId, current] of this.subagents) {
            await this.emitItem("item.completed", {
                ...current,
                status: danglingStatus,
            });
            this.subagents.delete(agentId);
        }
        if (this.activeCompact) {
            await this.emitItem("item.completed", {
                ...this.activeCompact,
                status: danglingStatus,
                error: "Turn 在 Compact 完成前结束",
            });
            this.activeCompact = undefined;
        }
    }

    getPersistedUIEvents() {
        return this.uiEvents.getEvents();
    }

    private async flushEndedTools(): Promise<void> {
        for (const toolCallId of this.endedTools) {
            const current = this.tools.get(toolCallId);
            if (!current) continue;
            await this.emitItem("item.completed", {
                ...current,
                status: terminalToolStatus(current.outcome),
            });
            for (const fileItem of this.fileChanges.get(toolCallId) ?? []) {
                await this.emitInstant(fileItem);
            }
            this.tools.delete(toolCallId);
            this.fileChanges.delete(toolCallId);
        }
        this.endedTools.clear();
    }

    private async emitInstant(item: ThreadItem): Promise<void> {
        await this.emitItem("item.started", {...item, status: "in_progress"});
        await this.emitItem("item.completed", item);
    }

    private async emitItem(
        type: "item.started" | "item.updated" | "item.completed",
        item: ThreadItem
    ): Promise<void> {
        await this.emit({type, turnId: this.turnId, item: structuredClone(item)});
    }

    private shouldEmitProgress(
        phase: string,
        estimatedOutputTokens: number
    ): boolean {
        const previous = this.lastProgress;
        return previous === undefined ||
            previous.phase !== phase ||
            phase === "retrying" ||
            phase === "stalled" ||
            estimatedOutputTokens - previous.estimatedOutputTokens >= 128;
    }

    private nextId(prefix: string): string {
        this.itemSequence += 1;
        return `${prefix}:${this.turnId}:${this.itemSequence}`;
    }
}
