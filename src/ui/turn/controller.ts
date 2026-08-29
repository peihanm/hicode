import type {AgentRunner} from "../../agent/index.js";
import type {AgentEvent} from "../../agent/types.js";
import type {Message} from "../../llm/types.js";
import type {ToolContext} from "../../tools/types.js";
import type {SlashCommandProcessor} from "../../slash/types.js";
import {createTurnAbortController, normalizeTurnAbortReason, type TurnAbortReason,} from "../../runtime/abort.js";
import type {ToolExecutor} from "../../agent/toolBatch.js";
import type {ToolSchemaProvider} from "../../agent/invokePreparation.js";
import {QueryGuard} from "./queryGuard.js";
import {RuntimeMessageQueue} from "../../runtime/messageQueue.js";
import {applyCommandToolPolicy} from "../../slash/toolPolicy.js";

interface UserPromptHookResult {
    blocked: boolean;
    blockReason?: string;
    additionalUserContextBlocks: readonly string[];
}

type Listener = () => void;

export interface UITurnStatus {
    busy: boolean;
    stopping: boolean;
    startedAt?: number;
    elapsedMs?: number;
}

export interface RestoredQueuedDraft {
    value: string;
    cursorOffset: number;
}

export interface UITurnControllerDependencies {
    getHistory(): Message[];

    createContext(signal: AbortSignal): ToolContext;

    onUserInput(input: string): void;

    onEvent(event: AgentEvent): void;

    onUnexpectedError(error: unknown): void;

    onQueuedInputConsumed(input: string): void;

    onTurnSettled(): void;

    denyPendingPermission(message: string): void;

    slashCommands: SlashCommandProcessor;

    openRewind?(): void;
    openAgents?(): void;

    openGitDiff?(): void;

    runUserPromptHooks(
        input: string,
        ctx: ToolContext
    ): Promise<UserPromptHookResult>;

    beginCheckpoint(input: string): Promise<void>;

    settleCheckpoint(): Promise<void>;

    runAgent: AgentRunner;

    persistSnapshot(): Promise<void>;

    getToolSchemas: ToolSchemaProvider;
    executeTool: ToolExecutor;

    isToolConcurrencySafe(name: string, argsJson: string): boolean;

    messageQueue: RuntimeMessageQueue;

    now(): number;
}

const IDLE_STATUS: UITurnStatus = {busy: false, stopping: false};

export class UITurnController {
    private readonly guard = new QueryGuard();
    private readonly listeners = new Set<Listener>();
    private active: { generation: number; controller: AbortController } | null = null;
    private immediateSlashController: AbortController | null = null;
    private snapshot: UITurnStatus = IDLE_STATUS;
    private disposed = false;

    constructor(private readonly dependencies: UITurnControllerDependencies) {
    }

    private now(): number {
        return this.dependencies.now();
    }

    async submit(input: string): Promise<boolean> {
        if (this.disposed || !this.guard.reserve()) return false;
        this.publish({busy: true, stopping: false, startedAt: this.now()});

        const controller = createTurnAbortController();
        const generation = this.guard.tryStart();
        if (generation === null) {
            this.guard.cancelReservation();
            this.publish(IDLE_STATUS);
            return false;
        }
        this.active = {generation, controller};

        try {
            const history = this.dependencies.getHistory();
            const ctx = this.dependencies.createContext(controller.signal);
            this.dependencies.onUserInput(input);

            let agentInput = input;
            let agentTools = {
                getToolSchemas: this.dependencies.getToolSchemas,
                executeTool: this.dependencies.executeTool,
                isToolConcurrencySafe: this.dependencies.isToolConcurrencySafe,
            };

            if (input.trim().startsWith("/")) {
                const slashResult = await this.dependencies.slashCommands.process(input, {
                    history,
                    ctx,
                    onEvent: this.dependencies.onEvent,
                    openRewind: this.dependencies.openRewind,
                    openAgents: this.dependencies.openAgents,
                    openGitDiff: this.dependencies.openGitDiff,
                });
                if (slashResult === true) return true;
                if (slashResult && typeof slashResult === "object") {
                    agentInput = slashResult.prompt;
                    agentTools = applyCommandToolPolicy(
                        agentTools,
                        slashResult.allowedTools
                    );
                }
            }

            await this.dependencies.beginCheckpoint(input);

            const hookResult = await this.dependencies.runUserPromptHooks(
                agentInput,
                ctx
            );
            if (controller.signal.aborted) {
                this.dependencies.onEvent({
                    type: "turn_interrupted",
                    reason: normalizeTurnAbortReason(controller.signal.reason),
                });
                return true;
            }
            if (hookResult.blocked) {
                this.dependencies.onEvent({
                    type: "assistant_text",
                    content: `UserPromptSubmit Hook 阻止了请求: ${hookResult.blockReason ?? "未提供原因"}`,
                });
                return true;
            }

            const historyLengthBeforeRun = history.length;
            try {
                await this.dependencies.runAgent(
                    agentInput,
                    history,
                    this.dependencies.onEvent,
                    ctx,
                    this.dependencies.messageQueue.createAgentInputChannel(
                        (message) => {
                            if (message.type === "user_input") {
                                this.dependencies.onQueuedInputConsumed(
                                    message.content
                                );
                            }
                        }
                    ),
                    {
                        getToolSchemas: agentTools.getToolSchemas,
                        executeTool: agentTools.executeTool,
                        isToolConcurrencySafe: agentTools.isToolConcurrencySafe,
                        additionalUserContextBlocks:
                            hookResult.additionalUserContextBlocks,
                    }
                );
            } finally {
                if (agentInput !== input) {
                    const expandedMessage = history.slice(historyLengthBeforeRun)
                        .find((message) =>
                            message.role === "user" && message.content === agentInput
                        );
                    if (expandedMessage?.role === "user") {
                        expandedMessage.content = input;
                    }
                }
            }
            return true;
        } catch (error) {
            if (controller.signal.aborted) {
                this.dependencies.onEvent({
                    type: "turn_interrupted",
                    reason: normalizeTurnAbortReason(controller.signal.reason),
                });
            } else {
                this.dependencies.onUnexpectedError(error);
            }
            return true;
        } finally {
            try {
                this.dependencies.onTurnSettled();
                await this.dependencies.settleCheckpoint();
                await this.dependencies.persistSnapshot();
            } finally {
                if (this.guard.end(generation)) {
                    this.active = null;
                    const startedAt = this.snapshot.startedAt;
                    this.publish({
                        busy: false,
                        stopping: false,
                        ...(startedAt === undefined
                            ? {}
                            : {elapsedMs: Math.max(0, this.now() - startedAt)}),
                    });
                    this.dependencies.messageQueue.demoteNextUserInputs();
                    const next = this.dependencies.messageQueue.dequeueDeferredTurnInput();
                    if (next && !this.disposed) {
                        queueMicrotask(() => {
                            void this.submit(next.content);
                        });
                    }
                }
            }
        }
    }

    enqueue(input: string): boolean {
        if (this.disposed || !this.snapshot.busy) return false;
        const trimmed = input.trim();
        if (
            trimmed.startsWith("/") &&
            this.dependencies.slashCommands.getBusyBehavior(trimmed) === "immediate" &&
            this.immediateSlashController === null
        ) {
            this.runImmediateSlash(trimmed);
            return true;
        }
        try {
            this.dependencies.messageQueue.enqueueUser(
                trimmed,
                trimmed.startsWith("/") ? "later" : "next"
            );
            return true;
        } catch (error) {
            this.dependencies.onUnexpectedError(error);
            return false;
        }
    }

    cancel(reason: TurnAbortReason = "user-cancel"): boolean {
        const active = this.active;
        if (!active || active.controller.signal.aborted) return false;
        this.publish({...this.snapshot, busy: true, stopping: true});
        active.controller.abort(reason);
        this.dependencies.denyPendingPermission("任务已取消");
        return true;
    }

    takeQueuedInputsForEditing(
        currentInput: string,
        currentCursorOffset: number
    ): RestoredQueuedDraft | undefined {
        const queuedInputs = this.dependencies.messageQueue.takeEditableInputs();
        if (queuedInputs.length === 0) return undefined;
        const queuedText = queuedInputs.join("\n");
        const separator = currentInput.length > 0 ? "\n" : "";
        return {
            value: `${queuedText}${separator}${currentInput}`,
            cursorOffset:
                queuedText.length + separator.length + currentCursorOffset,
        };
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const active = this.active;
        if (active && !active.controller.signal.aborted) {
            active.controller.abort("shutdown");
        }
        this.immediateSlashController?.abort("shutdown");
        this.immediateSlashController = null;
        this.dependencies.denyPendingPermission("应用正在关闭");
        this.listeners.clear();
    }

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): UITurnStatus => this.snapshot;

    private runImmediateSlash(input: string): void {
        const controller = createTurnAbortController();
        this.immediateSlashController = controller;
        this.dependencies.onUserInput(input);
        const history = this.dependencies.getHistory();
        const ctx = this.dependencies.createContext(controller.signal);
        void this.dependencies.slashCommands.process(input, {
            history,
            ctx,
            onEvent: this.dependencies.onEvent,
            openRewind: this.dependencies.openRewind,
            openAgents: this.dependencies.openAgents,
            openGitDiff: this.dependencies.openGitDiff,
        }).then((result) => {
            if (result !== true) {
                throw new Error(`运行中 Slash 未按本地命令完成: ${input}`);
            }
        }).catch((error) => {
            if (!controller.signal.aborted) {
                this.dependencies.onUnexpectedError(error);
            }
        }).finally(() => {
            if (this.immediateSlashController === controller) {
                this.immediateSlashController = null;
            }
        });
    }

    private publish(snapshot: UITurnStatus): void {
        if (
            snapshot.busy === this.snapshot.busy &&
            snapshot.stopping === this.snapshot.stopping &&
            snapshot.startedAt === this.snapshot.startedAt &&
            snapshot.elapsedMs === this.snapshot.elapsedMs
        ) {
            return;
        }
        this.snapshot = snapshot;
        for (const listener of this.listeners) listener();
    }
}
