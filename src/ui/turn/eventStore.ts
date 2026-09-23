import {toolFileChanges} from "../../fileChanges/index.js";
import type {MessageContent} from "../../images/content.js";
import {createAssistantThread, createTaskNotificationThread, createUserThread, reduceThreads, threadsFromHistory,} from "../conversation/threadReducer.js";
import type {AgentEvent} from "../../agent/types.js";
import type {UIThread} from "../conversation/types.js";
import type {LLMRetryInfo, Message} from "../../llm/types.js";
import {SessionUIEventCollector, type PersistedUIEvent,} from "../../session/index.js";
import {isSuccessfulToolActivity} from "../../tools/presentation.js";
import type {TaskNotification} from "../../tasks/index.js";

type Listener = () => void;

export interface UITokenInfo {
    count: number;
    percentUsed: number;
    warning: boolean;
    status: "unavailable" | "estimated" | "actual";
}

interface UITurnEventSnapshot {
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
    waitingAgents?: number;
    outputCharacters: number;
    estimatedOutputTokens: number;
    toolName?: string;
    idleMilliseconds?: number;
    retry?: LLMRetryInfo;
}

export interface UIModelStreamProgressRef {
    current: UIModelStreamInfo | null;
}

interface UITurnEventStoreOptions {
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
    private draft: Extract<AgentEvent, {type: "assistant_draft"}> | null = null;
    private readonly draftListeners = new Set<Listener>();
    getDraftSnapshot = () => this.draft;
    subscribeDraft = (listener: Listener): (() => void) => {
        this.draftListeners.add(listener);
        return () => {this.draftListeners.delete(listener);};
    };
    private updateDraft(draft: typeof this.draft): void {
        if (this.draft === draft) return;
        this.draft = draft;
        for (const listener of this.draftListeners) listener();
    }
    private readonly listeners = new Set<Listener>();
    private readonly modelStreamProgressRef: UIModelStreamProgressRef = {
        current: null,
    };
    private readonly archivedThreadIds = new Set<string>();
    private activeIteration = 0;
    private threadSequence = 0;
    private readonly uiEvents: SessionUIEventCollector;
    private snapshot: UITurnEventSnapshot;

    constructor(options: UITurnEventStoreOptions = {}) {
        const history = options.history ?? [];
        this.uiEvents = new SessionUIEventCollector(options.uiEvents);
        const restoredThreads = threadsFromHistory(
            history,
            [...this.uiEvents.getEvents()],
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
        this.uiEvents.handleEvent(event);

        if (event.type === "agent_wait") {
            const modelStream: UIModelStreamInfo | null = event.taskIds.length
                ? {phase: "requesting", waitingAgents: event.taskIds.length, outputCharacters: 0, estimatedOutputTokens: 0}
                : null;
            this.modelStreamProgressRef.current = modelStream;
            this.update({...this.snapshot, modelStream});
            return;
        }

        if (event.type === "assistant_draft") {
            if (!this.draft?.text.trim() && event.text.trim()) this.archiveSettledThreads();
            this.updateDraft(event);
            return;
        }
        if (event.type === "assistant_draft_end") {
            if (event.disposition === "discarded" && this.draft?.responseId === event.responseId) this.updateDraft(null);
            return;
        }
        // Keep the draft until its final text arrives, so the terminal replaces it in one transition.
        if (event.type === "assistant_text" && event.responseId === this.draft?.responseId) this.updateDraft(null);
        if (event.type === "turn_interrupted") this.updateDraft(null);
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
                ...(event.retry ? {retry: event.retry} : {}),
                ...(event.toolName ? {toolName: event.toolName} : {}),
                ...(event.idleMilliseconds !== undefined
                    ? {idleMilliseconds: event.idleMilliseconds}
                    : {}),
            };
            // Each delta updates only the ref;
            // progress within the same phase does not update the root App external store.
            this.modelStreamProgressRef.current = modelStream;
            const phaseChanged = current?.phase !== event.phase;
            const toolChanged = current?.toolName !== event.toolName;
            if (
                event.phase !== "stalled" &&
                event.phase !== "retrying" &&
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
            toolFileChanges(event.uiData, event.outcome).length > 0
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
            // Non-exploration tools enter Static atomically after all batch siblings finish.
            // Successful trailing exploration stays live across iterations for aggregation until a semantic boundary.
            // File changes remain until the iteration boundary to merge their final net diff.
            const completedToolCallId =
                event.type === "tool_call_end" &&
                toolFileChanges(event.uiData, event.outcome).length === 0
                    ? event.toolCallId
                    : undefined;
            // assistant_text is already complete commentary or final text, with no future deltas. Putting it
            // in the live area until Turn settlement can push a long response into terminal
            // scrollback, where Ink cannot erase it, causing duplicate output on entry to Static.
            const completedAssistantId =
                event.type === "assistant_text" ||
                event.type === "compact_start" ||
                event.type === "compact_end" ||
                event.type === "compact_error" ||
                event.type === "turn_interrupted"
                ? threads.at(-1)?.id
                : undefined;
            if (event.type === "hook_completed") {
                this.update(this.archiveThroughSettledThread(nextSnapshot, `hook:${event.execution.executionId}`));
            } else if (completedAssistantId) {
                // Fast commands such as Slash may return before user input reaches Static.
                // Freeze the final answer together with preceding completed messages not yet archived;
                // otherwise Static prints the answer before Turn settlement prints the user command.
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

    appendUser(input: MessageContent): void {
        this.archiveSettledThreads();
        const thread = createUserThread(input, this.createThreadId);
        const nextSnapshot = {
            ...this.snapshot,
            threads: [...this.snapshot.threads, thread],
        };
        // Submitted user text no longer changes. Moving it from live rendering into Static after
        // a long prompt enters scrollback physically prints it twice. Like complete assistant
        // text, freeze it atomically when no preceding tools remain unfinished.
        this.update(this.archiveThroughSettledThread(nextSnapshot, thread.id));
    }

    appendError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.appendCompletedAssistant(`Error: ${message}`);
    }

    appendWarning(message: string): void {
        this.appendCompletedAssistant(`Warning: ${message}`);
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
        return [...this.uiEvents.getEvents()];
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
        this.uiEvents.reset(input.uiEvents);
        this.archivedThreadIds.clear();
        for (const thread of threads) this.archivedThreadIds.add(thread.id);
        this.activeIteration = 0;
        this.updateDraft(null);
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
        this.updateDraft(null);
        this.archiveSettledThreads();
    }

    private archiveSettledThreads(): void {
        const nextSnapshot = this.archiveMatchingThreads(
            this.snapshot,
            (thread) =>
                !((thread.role === "tool_call" || thread.role === "hook") && thread.status === "running")
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
                !((thread.role === "tool_call" || thread.role === "hook") && thread.status === "running")
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
                (thread.role === "tool_call" || thread.role === "hook") &&
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
                // UI subscribers cannot disrupt the Agent event chain.
            }
        }
    }

    private createThreadId = (): string => {
        this.threadSequence += 1;
        return `thread-${this.threadSequence}`;
    };
}
