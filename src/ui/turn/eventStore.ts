import {createAssistantThread, createTaskNotificationThread, createUserThread, reduceThreads, threadsFromHistory,} from "../conversation/threadReducer.js";
import type {AgentEvent} from "../../agent/types.js";
import type {UIThread} from "../conversation/types.js";
import type {Message} from "../../llm/types.js";
import {mergeFileChange} from "../../fileChanges/index.js";
import {limitPersistedUIEvents, type PersistedFileChangeUIEvent, type PersistedUIEvent,} from "../../session/index.js";
import {isSuccessfulToolActivity} from "../../tools/presentation.js";
import type {TaskNotification} from "../../tasks/index.js";

type Listener = () => void;

export interface UITokenInfo {
    count: number;
    percentUsed: number;
    warning: boolean;
    status: "unavailable" | "estimated" | "actual";
}

export interface UITurnEventSnapshot {
    threads: UIThread[];
    staticThreads: UIThread[];
    tokenInfo: UITokenInfo;
    modelStream: UIModelStreamInfo | null;
}

export interface UIModelStreamInfo {
    phase:
        | "requesting"
        | "reasoning"
        | "content"
        | "tool_input"
        | "retrying"
        | "stalled";
    outputCharacters: number;
    estimatedOutputTokens: number;
    toolName?: string;
    idleMilliseconds?: number;
}

export interface UIModelStreamProgressRef {
    current: UIModelStreamInfo | null;
}

export interface UITurnEventStoreOptions {
    history?: Message[];
    uiEvents?: PersistedUIEvent[];
    initialTokenInfo?: UITokenInfo;
}

const EMPTY_TOKEN_INFO: UITokenInfo = {
    count: 0,
    percentUsed: 0,
    warning: false,
    status: "unavailable",
};

export class UITurnEventStore {
    private readonly listeners = new Set<Listener>();
    private readonly modelStreamProgressRef: UIModelStreamProgressRef = {
        current: null,
    };
    private readonly archivedThreadIds = new Set<string>();
    private activeIteration = 0;
    private threadSequence = 0;
    private persistedUIEvents: PersistedUIEvent[];
    private snapshot: UITurnEventSnapshot;

    constructor(options: UITurnEventStoreOptions = {}) {
        const history = options.history ?? [];
        this.persistedUIEvents = [...(options.uiEvents ?? [])];
        const restoredThreads = threadsFromHistory(
            history,
            this.persistedUIEvents,
            this.createThreadId
        );
        for (const thread of restoredThreads) this.archivedThreadIds.add(thread.id);
        this.snapshot = {
            threads: restoredThreads,
            staticThreads: restoredThreads,
            tokenInfo: options.initialTokenInfo ?? EMPTY_TOKEN_INFO,
            modelStream: null,
        };
    }

    handleEvent = (event: AgentEvent): void => {
        if (event.type === "iteration") {
            this.activeIteration = event.current;
            this.archiveSettledBeforeTrailingActivity();
            return;
        }
        if (event.type === "model_stream_start") {
            const modelStream: UIModelStreamInfo = {
                phase: "requesting",
                outputCharacters: 0,
                estimatedOutputTokens: 0,
            };
            this.modelStreamProgressRef.current = modelStream;
            this.update({
                ...this.snapshot,
                modelStream,
            });
            return;
        }
        if (event.type === "model_stream_progress") {
            const current = this.snapshot.modelStream;
            const modelStream: UIModelStreamInfo = {
                phase: event.phase,
                outputCharacters: event.outputCharacters,
                estimatedOutputTokens: event.estimatedOutputTokens,
                ...(event.toolName ? {toolName: event.toolName} : {}),
                ...(event.idleMilliseconds !== undefined
                    ? {idleMilliseconds: event.idleMilliseconds}
                    : {}),
            };
            // 与 Claude Code 的 responseLengthRef 相同：每个 delta 都只写 ref，
            // 同阶段进度不触发根 App 的 external-store 更新。
            this.modelStreamProgressRef.current = modelStream;
            const phaseChanged = current?.phase !== event.phase;
            const toolChanged = current?.toolName !== event.toolName;
            if (
                event.phase !== "stalled" &&
                !phaseChanged &&
                !toolChanged
            ) {
                return;
            }
            this.update({
                ...this.snapshot,
                modelStream,
            });
            return;
        }
        if (event.type === "model_stream_end") {
            this.modelStreamProgressRef.current = null;
            this.update({...this.snapshot, modelStream: null});
            return;
        }
        if (event.type === "token_update") {
            this.update({
                ...this.snapshot,
                tokenInfo: {
                    count: event.tokenCount,
                    percentUsed: event.percentUsed,
                    warning: event.warning,
                    status: event.status,
                },
            });
            return;
        }

        if (
            event.type === "tool_call_end" &&
            event.outcome === "ok" &&
            event.uiData?.type === "file_change"
        ) {
            const previous = [...this.persistedUIEvents].reverse().find(
                (item): item is PersistedFileChangeUIEvent =>
                    item.type === "file_change" &&
                    item.turnId === event.turnId &&
                    item.change.path === event.uiData!.change.path
            );
            const persistedChange = previous
                ? mergeFileChange([previous.change], event.uiData.change).at(-1)!
                : event.uiData.change;
            this.persistedUIEvents = limitPersistedUIEvents([
                ...this.persistedUIEvents,
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
        if (event.type === "tool_call_end") {
            this.persistedUIEvents = limitPersistedUIEvents([
                ...this.persistedUIEvents,
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

        if (
            event.type === "tool_call_start" &&
            !isSuccessfulToolActivity({
                name: event.name,
                args: event.args,
                status: "running",
            })
        ) {
            this.archiveSettledThreads();
        }

        const displayEvent =
            event.type === "tool_call_end" &&
            event.uiData?.type === "file_change"
                ? {
                    ...event,
                    turnId: `${event.turnId}:iteration:${this.activeIteration}`,
                }
                : event;
        const threads = reduceThreads(
            this.snapshot.threads,
            displayEvent,
            this.createThreadId
        );
        if (threads !== this.snapshot.threads) {
            const nextSnapshot = {...this.snapshot, threads};
            // 非探索工具在同批 sibling 全部完成后原子转入 Static。尾部成功
            // 探索则跨 iteration 留在 live 区继续聚合，直到出现语义边界；
            // 文件修改继续留到 iteration 边界以合并最终净 diff。
            const completedToolCallId =
                event.type === "tool_call_end" &&
                event.uiData?.type !== "file_change"
                    ? event.toolCallId
                    : undefined;
            // assistant_text 已经是完整的最终文本，不存在后续增量更新。若先放进
            // live 区、Turn settled 时再转入 Static，长回答可能已经滚进终端
            // scrollback，Ink 无法擦除旧帧，最终就会看起来输出了两次。
            const completedAssistantId =
                event.type === "assistant_text" ||
                event.type === "compact_start" ||
                event.type === "compact_end" ||
                event.type === "compact_error" ||
                event.type === "turn_interrupted"
                ? threads.at(-1)?.id
                : undefined;
            if (completedAssistantId) {
                // Slash 等快速命令可能在用户输入尚未进入 Static 时立即返回。
                // 最终回答必须连同它之前尚未归档的已完成消息一起固化，否则
                // Static 会先写回答、Turn settle 时再写用户命令，时间顺序反转。
                this.update(
                    this.archiveThroughSettledThread(
                        nextSnapshot,
                        completedAssistantId
                    )
                );
            } else if (completedToolCallId) {
                const completed = threads.find(
                    (thread) =>
                        thread.role === "tool_call" &&
                        thread.toolCallId === completedToolCallId
                );
                const turnId = completed?.role === "tool_call"
                    ? completed.turnId
                    : undefined;
                const turnTools = turnId
                    ? threads.filter(
                        (thread): thread is Extract<UIThread, {role: "tool_call"}> =>
                            thread.role === "tool_call" && thread.turnId === turnId
                    )
                    : [];
                const hasRunningSibling = turnTools.some(
                    (thread) => thread.status === "running"
                );
                const activityOnly = turnTools.length > 0 && turnTools.every(
                    (thread) => isSuccessfulToolActivity(thread)
                );
                if (hasRunningSibling || activityOnly) {
                    this.update(nextSnapshot);
                } else {
                    const lastTurnTool = turnTools.at(-1) ?? completed;
                    this.update(
                        lastTurnTool?.role === "tool_call"
                            ? this.archiveThroughSettledThread(
                                nextSnapshot,
                                lastTurnTool.id
                            )
                            : nextSnapshot
                    );
                }
            } else {
                this.update(nextSnapshot);
            }
        }
    };

    appendUser(input: string): void {
        this.archiveSettledThreads();
        const thread = createUserThread(input, this.createThreadId);
        const nextSnapshot = {
            ...this.snapshot,
            threads: [...this.snapshot.threads, thread],
        };
        // 用户提交的文本不会再更新。若先进入 live 区，长 Prompt 已滚入终端
        // scrollback 后再迁入 Static 会被物理打印两次；因此与完整 Assistant
        // 文本一样，在没有未完成前置工具时直接原子固化。
        this.update(this.archiveThroughSettledThread(nextSnapshot, thread.id));
    }

    appendError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.appendCompletedAssistant(`出错: ${message}`);
    }

    appendWarning(message: string): void {
        this.appendCompletedAssistant(`警告: ${message}`);
    }

    appendNotice(message: string): void {
        this.appendCompletedAssistant(message);
    }

    appendTaskNotification(notification: TaskNotification): void {
        const thread = createTaskNotificationThread(
            notification,
            this.createThreadId
        );
        const nextSnapshot = {
            ...this.snapshot,
            threads: [...this.snapshot.threads, thread],
        };
        this.update(this.archiveThroughSettledThread(nextSnapshot, thread.id));
    }

    getPersistedUIEvents(): PersistedUIEvent[] {
        return [...this.persistedUIEvents];
    }

    getModelStreamProgressRef(): UIModelStreamProgressRef {
        return this.modelStreamProgressRef;
    }

    updateTokenInfo(tokenInfo: UITokenInfo): void {
        this.update({...this.snapshot, tokenInfo});
    }

    restore(input: {
        history: Message[];
        uiEvents: PersistedUIEvent[];
        tokenInfo?: UITokenInfo;
    }): void {
        const threads = threadsFromHistory(
            input.history,
            input.uiEvents,
            this.createThreadId
        );
        this.persistedUIEvents = [...input.uiEvents];
        this.archivedThreadIds.clear();
        for (const thread of threads) this.archivedThreadIds.add(thread.id);
        this.activeIteration = 0;
        this.modelStreamProgressRef.current = null;
        this.update({
            threads,
            staticThreads: threads,
            tokenInfo: input.tokenInfo ?? EMPTY_TOKEN_INFO,
            modelStream: null,
        });
    }

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): UITurnEventSnapshot => this.snapshot;

    settleTurn(): void {
        this.archiveSettledThreads();
    }

    private archiveSettledThreads(): void {
        const nextSnapshot = this.archiveMatchingThreads(
            this.snapshot,
            (thread) =>
                !(thread.role === "tool_call" && thread.status === "running")
        );
        if (nextSnapshot !== this.snapshot) this.update(nextSnapshot);
    }

    private appendCompletedAssistant(text: string): void {
        const thread = createAssistantThread(text, this.createThreadId);
        const nextSnapshot = {
            ...this.snapshot,
            threads: [...this.snapshot.threads, thread],
        };
        this.update(this.archiveThroughSettledThread(nextSnapshot, thread.id));
    }

    private archiveSettledBeforeTrailingActivity(): void {
        let trailingStart = this.snapshot.threads.length;
        for (let index = this.snapshot.threads.length - 1; index >= 0; index--) {
            const thread = this.snapshot.threads[index]!;
            if (this.archivedThreadIds.has(thread.id)) break;
            if (
                thread.role === "tool_call" &&
                thread.status === "done" &&
                isSuccessfulToolActivity(thread)
            ) {
                trailingStart = index;
                continue;
            }
            break;
        }
        const trailingIds = new Set(
            this.snapshot.threads.slice(trailingStart).map((thread) => thread.id)
        );
        const nextSnapshot = this.archiveMatchingThreads(
            this.snapshot,
            (thread) =>
                !trailingIds.has(thread.id) &&
                !(thread.role === "tool_call" && thread.status === "running")
        );
        if (nextSnapshot !== this.snapshot) this.update(nextSnapshot);
    }

    private archiveMatchingThreads(
        snapshot: UITurnEventSnapshot,
        matches: (thread: UIThread) => boolean
    ): UITurnEventSnapshot {
        const additions = snapshot.threads.filter(
            (thread) =>
                !this.archivedThreadIds.has(thread.id) && matches(thread)
        );
        if (additions.length === 0) return snapshot;
        for (const thread of additions) this.archivedThreadIds.add(thread.id);
        return {
            ...snapshot,
            staticThreads: [...snapshot.staticThreads, ...additions],
        };
    }

    private archiveThroughSettledThread(
        snapshot: UITurnEventSnapshot,
        targetThreadId: string
    ): UITurnEventSnapshot {
        const targetIndex = snapshot.threads.findIndex(
            (thread) => thread.id === targetThreadId
        );
        if (targetIndex < 0) return snapshot;

        const prefix = snapshot.threads.slice(0, targetIndex + 1);
        const hasRunningPredecessor = prefix.some(
            (thread) =>
                !this.archivedThreadIds.has(thread.id) &&
                thread.role === "tool_call" &&
                thread.status === "running"
        );
        if (hasRunningPredecessor) return snapshot;

        const prefixIds = new Set(prefix.map((thread) => thread.id));
        return this.archiveMatchingThreads(
            snapshot,
            (thread) => prefixIds.has(thread.id)
        );
    }

    private update(snapshot: UITurnEventSnapshot): void {
        this.snapshot = snapshot;
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // UI subscriber 不能破坏 Agent event 链。
            }
        }
    }

    private createThreadId = (): string => {
        this.threadSequence += 1;
        return `thread-${this.threadSequence}`;
    };
}
