import {contentText, type MessageContent} from "../../images/content.js";
import {userContentText} from "./userContent.js";
import {toolFileChanges} from "../../fileChanges/index.js";
import {randomUUID} from "node:crypto";
import {mergeFileChange} from "../../fileChanges/index.js";
import type {PersistedUIEvent} from "../../session/index.js";
import type {AgentEvent} from "../../agent/types.js";
import type {Message} from "../../llm/types.js";
import type {TaskNotification} from "../../tasks/index.js";
import type {SubagentProgressItem, UIThread} from "./types.js";

export type ThreadIdFactory = () => string;

function randomThreadId(): string {
    return `thread-${randomUUID()}`;
}

// 构造单条 UI 线程（user 输入 / assistant 文本 / 错误信息）
// ID 生成封装在内部，调用方不直接接触 nextId
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
                if (target.name === "agent") {
                    target.result = "Done (resumed session)";
                    target.subagentReport = contentText(message.content);
                } else {
                    target.result = contentText(message.content);
                }
            }
        }
    }

    for (const event of uiEvents) {
        if (event.type === "turn_timing" || event.type === "approval_review") continue;
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
            result: target.result ?? "文件已修改",
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
    if (event.type === "token_update") return items;
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

// AgentEvent → UIThread 的纯 reducer
// App.tsx 调用：setThreads((prev) => reduceThreads(prev, event))
//
// 为什么用 reducer 而不是 eventToThread(event): UIThread | null：
//   tool_call_end 不是"新增一条"，而是"更新已有的一条"，
//   形态是 (threads, event) → threads，reducer 天然对齐
export function reduceThreads(
    threads: UIThread[],
    event: AgentEvent,
    createId: ThreadIdFactory = randomThreadId
): UIThread[] {
    switch (event.type) {
        case "approval_review":
            return threads.map(thread => thread.role === "tool_call" && thread.toolCallId === event.toolCallId
                ? {...thread, approvalReview: event.phase === "start" ? "正在自动审核权限" : undefined} : thread);
        case "iteration":
        case "turn_timing":
            return threads;
        case "assistant_draft":
        case "assistant_draft_end":
        case "model_stream_start":
        case "model_stream_progress":
        case "model_stream_end":
            return threads;
        case "token_update":
            // token_update 只更新 StatusBar，不影响消息列表
            return threads;
        case "memory_update":
            // Memory 工具和 slash command 已经拥有可见反馈。该事件只负责
            // Runtime/Headless 状态通知，TUI 不再额外插入重复的 assistant 消息。
            return threads;
        case "turn_interrupted":
            return [
                ...threads,
                {
                    id: createId(),
                    role: "assistant",
                    text: `任务已取消（${event.reason}）`,
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
                        // 标题已经包含 Agent 类型和 description；运行中不再用 result
                        // 重复一遍。唯一动态进度由底部 ModelStreamStatus 承担。
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
                    text: `${label}: ${formatTokens(event.tokenCount)} / ${formatTokens(event.threshold)} tokens，正在压缩上下文...`,
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
                    text: `${label} 完成: ${formatTokens(event.preTokenCount)} -> ${formatTokens(event.postTokenCount)} tokens`,
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
                    text: `${label} 失败: ${event.message}`,
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
