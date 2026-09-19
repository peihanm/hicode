import {contentText, type MessageContent} from "../../images/content.js";
import {userContentText} from "./userContent.js";
import {toolFileChanges} from "../../fileChanges/index.js";
import {randomUUID} from "node:crypto";
import {mergeFileChange} from "../../fileChanges/index.js";
import type {PersistedUIEvent} from "../../session/index.js";
import {isBackgroundAgentCall} from "../../tools/presentation.js";
import type {AgentEvent} from "../../agent/types.js";
import type {Message} from "../../llm/types.js";
import type {TaskNotification} from "../../tasks/index.js";
import type {SubagentProgressItem, UIThread} from "./types.js";

export type ThreadIdFactory = () => string;

function randomThreadId(): string {
    return `thread-${randomUUID()}`;
}

// Build one UI thread for user input, assistant text or errors.
// ID generation is internal; callers never access nextId directly.
export function createUserThread(
    content: MessageContent,
    createId: ThreadIdFactory = randomThreadId
): UIThread {
    return {id: createId(), role: "user", text: userContentText(content)};
}

export function createAssistantThread(
    text: string,
    createId: ThreadIdFactory = randomThreadId
): UIThread {
    return {id: createId(), role: "assistant", text};
}

export function createTaskNotificationThread(
    notification: TaskNotification,
    createId: ThreadIdFactory = randomThreadId
): UIThread {
    return {
        id: createId(),
        role: "task_notification",
        taskId: notification.taskId,
        ownerToolCallId: notification.ownerToolCallId,
        kind: notification.kind,
        label: notification.label,
        status: notification.status,
        summary: notification.summary,
        ...(notification.resultId ? {resultId: notification.resultId} : {}),
    };
}

function textFromUserMessage(message: Extract<Message, { role: "user" }>): string {
    return userContentText(message.content);
}

export function threadsFromHistory(
    history: Message[],
    uiEvents: PersistedUIEvent[] = [],
    createId: ThreadIdFactory = randomThreadId
): UIThread[] {
    let threads: UIThread[] = [];

    for (const message of history) {
        if (message.role === "user") {
            const text = textFromUserMessage(message);
            if (message.origin === "agent" && text.trim()) threads.push({id: createId(), role: "coordination_message", text});
            if (message.origin === "user" && text.trim().length > 0) {
                threads.push(createUserThread(text, createId));
            }
            continue;
        }

        if (message.role === "assistant") {
            if (typeof message.content === "string" && message.content.trim()) {
                threads.push(createAssistantThread(message.content, createId));
            }
            for (const toolCall of message.tool_calls ?? []) {
                threads.push({
                    id: createId(),
                    role: "tool_call",
                    toolCallId: toolCall.id,
                    name: toolCall.function.name,
                    args: toolCall.function.arguments,
                    status: "done",
                });
            }
            continue;
        }

        if (message.role === "tool") {
            const target = threads.find(
                (thread) =>
                    thread.role === "tool_call" &&
                    thread.toolCallId === message.tool_call_id
            );
            if (target?.role === "tool_call") {
                target.status = "done";
                if (target.name === "agent" && !isBackgroundAgentCall(target.name, target.args)) {
                    target.result = "Done (resumed session)";
                    target.subagentReport = contentText(message.content);
                } else {
                    target.result = contentText(message.content);
                }
            }
        }
    }

    for (const event of uiEvents) {
        if (event.type === "approval_review") continue;
        const target = threads.find(
            (thread) =>
                thread.role === "tool_call" && thread.toolCallId === event.toolCallId
        );
        if (!target || target.role !== "tool_call") continue;
        if (event.type === "tool_call") {
            target.outcome = event.outcome;
            continue;
        }
        threads = reduceThreads(threads, {
            type: "tool_call_end",
            turnId: event.turnId,
            toolCallId: event.toolCallId,
            result: target.result ?? "File modified",
            outcome: "ok",
            uiData: {type: "file_change", change: event.change},
        }, createId);
    }
    return threads;
}

function formatTokens(tokens: number): string {
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
    return String(tokens);
}

function subagentCompletionLabel(
    event: Extract<AgentEvent, { type: "subagent_end" }>
): string {
    if (
        event.reason === "incomplete" ||
        event.reason === "max_turns" ||
        event.reason === "permission_denied" ||
        event.reason === "interrupted"
    ) {
        return "Stopped";
    }
    return "Done";
}

const MAX_SUBAGENT_PROGRESS_ITEMS = 100;

function updateSubagentProgress(
    items: SubagentProgressItem[] | undefined,
    event: Extract<AgentEvent, {type: "subagent_progress"}>["event"]
): SubagentProgressItem[] | undefined {
    if (event.type === "token_update" || event.type === "todos") return items;
    if (event.type === "tool_start") {
        return [
            ...(items ?? []),
            {
                toolCallId: event.toolCallId,
                name: event.name,
                args: event.args,
                status: "running" as const,
            },
        ].slice(-MAX_SUBAGENT_PROGRESS_ITEMS);
    }
    return (items ?? []).map((item) =>
        item.toolCallId === event.toolCallId
            ? {
                ...item,
                status: "done" as const,
            }
            : item
    );
}

// Pure reducer from AgentEvent to UIThread state.
// App.tsx calls setThreads(prev => reduceThreads(prev, event)).
//
// A reducer is needed instead of eventToThread(event): UIThread | null because
// tool_call_end updates an existing entry rather than adding a new one.
// The (threads, event) -> threads shape naturally fits a reducer.
export function reduceThreads(
    threads: UIThread[],
    event: AgentEvent,
    createId: ThreadIdFactory = randomThreadId
): UIThread[] {
    switch (event.type) {
        case "coordination_message":
            return [...threads, {id: createId(), role: "coordination_message", text: event.text}];
        case "approval_review":
            return threads.map(thread => thread.role === "tool_call" && thread.toolCallId === event.toolCallId
                ? {...thread, approvalReview: event.phase === "start" ? event.source === "user" ? "Waiting for approval" : "Reviewing permissions automatically" : undefined} : thread);
        case "iteration":
        case "agent_wait":
            return threads;
        case "assistant_draft":
        case "assistant_draft_end":
        case "model_stream_start":
        case "model_stream_progress":
        case "model_stream_end":
            return threads;
        case "token_update":
            // token_update changes StatusBar only, not the message list.
            return threads;
        case "memory_update":
            // Memory tools and Slash commands already provide visible feedback. This event only
            // notifies Runtime/Headless state; the TUI does not add a duplicate assistant message.
            return threads;
        case "turn_interrupted":
            return [
                ...threads,
                {
                    id: createId(),
                    role: "assistant",
                    text: `Task cancelled (${event.reason})`,
                },
            ];
        case "subagent_start":
            return threads.map((thread) =>
                thread.role === "tool_call" &&
                thread.toolCallId === event.parentToolCallId
                    ? {
                        ...thread,
                        subagentId: event.agentId,
                        subagentType: event.agentType,
                        ...(event.agentName ? {subagentName: event.agentName} : {}),
                        // The title already contains Agent type and description; do not repeat them in result
                        // while running. ModelStreamStatus at the bottom owns dynamic progress.
                        result: "",
                    }
                    : thread
            );
        case "subagent_progress":
            return threads.map((thread) =>
                thread.role === "tool_call" && thread.subagentId === event.agentId
                    ? event.event.type === "token_update"
                        ? {...thread, subagentTokenCount: event.event.tokenCount}
                        : {
                            ...thread,
                            subagentProgress: updateSubagentProgress(
                                thread.subagentProgress,
                                event.event
                            ),
                        }
                    : thread
            );
        case "subagent_end":
            return threads.map((thread) =>
                thread.role === "tool_call" && thread.subagentId === event.agentId
                    ? {
                        ...thread,
                        result: `${subagentCompletionLabel(event)} (${event.toolUseCount} tool calls · ${event.iterations} iterations · ${formatDuration(event.durationMs)})`,
                        subagentReport: event.report,
                        subagentIterations: event.iterations,
                        subagentToolUseCount: event.toolUseCount,
                        subagentDurationMs: event.durationMs,
                        ...(event.transcriptPath
                            ? {subagentTranscriptPath: event.transcriptPath}
                            : {}),
                    }
                    : thread
            );
        case "subagent_error":
            return threads.map((thread) =>
                thread.role === "tool_call" && thread.subagentId === event.agentId
                    ? {...thread, result: `${event.agentType} failed: ${event.message}`}
                    : thread
            );
        case "turn_end":
            return threads;
        case "hook_started":
        case "hook_completed": {
            const item: UIThread = {id: `hook:${event.execution.executionId}`, role: "hook",
                status: event.type === "hook_started" ? "running" : "done",
                execution: {...event.execution, handler: event.execution.handler.slice(0, 180)}};
            return threads.some(thread => thread.id === item.id)
                ? threads.map(thread => thread.id === item.id ? item : thread) : [...threads, item];
        }
        case "assistant_text":
            return [
                ...threads,
                {id: createId(), role: "assistant", text: event.content},
            ];
        case "compact_start": {
            const label = event.trigger === "manual" ? "Compact" : "Auto-compact";
            return [
                ...threads,
                {
                    id: createId(),
                    role: "assistant",
                    text: `${label}: ${formatTokens(event.tokenCount)} / ${formatTokens(event.threshold)} tokens; compacting context...`,
                },
            ];
        }
        case "compact_end": {
            const label = event.trigger === "manual" ? "Compact" : "Auto-compact";
            return [
                ...threads,
                {
                    id: createId(),
                    role: "assistant",
                    text: `${label} completed: ${formatTokens(event.preTokenCount)} -> ${formatTokens(event.postTokenCount)} tokens`,
                },
            ];
        }
        case "compact_error": {
            const label = event.trigger === "manual" ? "Compact" : "Auto-compact";
            return [
                ...threads,
                {
                    id: createId(),
                    role: "assistant",
                    text: `${label} failed: ${event.message}`,
                },
            ];
        }
        case "tool_call_start":
            return [
                ...threads,
                {
                    id: createId(),
                    role: "tool_call",
                    turnId: event.turnId,
                    toolCallId: event.toolCallId,
                    name: event.name,
                    args: event.args,
                    status: "running",
                },
            ];
        case "tool_call_end": {
            const changes = toolFileChanges(event.uiData, event.outcome);
            const updated: UIThread[] = threads.map((t): UIThread =>
                t.role === "tool_call" && t.toolCallId === event.toolCallId
                    ? t.name === "agent" && t.subagentReport
                        ? {
                            ...t,
                            status: "done" as const,
                            outcome: event.outcome ?? "ok",
                            ...(event.persisted ? {persisted: event.persisted} : {}),
                        }
                        : {
                            ...t,
                            status: "done" as const,
                            outcome: event.outcome ?? "ok",
                            result: event.result,
                            turnId: event.turnId,
                            ...(event.uiData ? {uiData: event.uiData} : {}),
                            ...(changes.length > 0 && event.uiData?.type === "file_change" && t.name !== "bash"
                                ? {hiddenByFileChange: true}
                                : {}),
                            ...(event.persisted ? {persisted: event.persisted} : {}),
                        }
                    : t
            );
            if (changes.length === 0) {
                return updated;
            }
            const turnId = event.turnId;
            const groupIndex = updated.findIndex(
                (thread) =>
                    thread.role === "file_change_group" && thread.turnId === turnId
            );
            if (groupIndex >= 0) {
                return updated.map((thread, index) =>
                    index === groupIndex && thread.role === "file_change_group"
                        ? {
                            ...thread,
                            changes: changes.reduce((current, change) => mergeFileChange(current, change), thread.changes),
                        }
                        : thread
                );
            }
            const toolIndex = updated.findIndex(
                (thread) =>
                    thread.role === "tool_call" && thread.toolCallId === event.toolCallId
            );
            const group: UIThread = {
                id: createId(),
                role: "file_change_group",
                turnId,
                changes: [...changes],
            };
            if (toolIndex < 0) return [...updated, group];
            return [
                ...updated.slice(0, toolIndex + 1),
                group,
                ...updated.slice(toolIndex + 1),
            ];
        }
        case "tool_result_persisted":
            return threads.map((t) =>
                t.role === "tool_call" && t.toolCallId === event.toolCallId
                    ? {...t, persisted: event.persisted}
                    : t
            );
    }
}

function formatDuration(durationMs: number): string {
    if (durationMs < 1000) return `${durationMs}ms`;
    const seconds = Math.round(durationMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
