import type {AgentEvent} from "../../agent/types.js";
import type {Message} from "../../llm/types.js";
import type {ToolContext} from "../../tools/types.js";
import type {SlashCommandProcessor} from "../../slash/types.js";
import {createTurnAbortController, type TurnAbortReason,} from "../../runtime/abort.js";
import {QueryGuard} from "./queryGuard.js";
import {RuntimeMessageQueue} from "../../runtime/messageQueue.js";

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

    denyPendingPermission(message: string): void;

    slashCommands: SlashCommandProcessor;

    initialize(): Promise<void>;

    openResume?(): void;
    openRewind?(): void;
    openAgents?(): void;

    openGitDiff?(): void;
    openModel?(): void;
    openPermissions?(): void;

    runTurn(input: string, signal: AbortSignal): Promise<void>;

    messageQueue: RuntimeMessageQueue;

    now(): number;
}

const IDLE_STATUS: UITurnStatus = {busy: false, stopping: false};

export class UITurnController {
    private readonly guard = new QueryGuard();
    private readonly listeners = new Set<Listener>();
    private active: { generation: number; controller: AbortController } | null = null;
    private activeTurnSettled: Promise<void> | null = null;
    private resolveActiveTurn: (() => void) | null = null;
    private immediateSlashController: AbortController | null = null;
    private immediateSlashSettled: Promise<void> | null = null;
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
        this.activeTurnSettled = new Promise<void>((resolve) => {
            this.resolveActiveTurn = resolve;
        });

        try {
            this.dependencies.onUserInput(input);
            await this.dependencies.initialize();
            const history = this.dependencies.getHistory();

            if (input.trim().startsWith("/")) {
                const ctx = this.dependencies.createContext(controller.signal);
                const handled = await this.dependencies.slashCommands.process(input, {
                    history,
                    ctx,
                    onEvent: this.dependencies.onEvent,
                    openResume: this.dependencies.openResume,
                    openRewind: this.dependencies.openRewind,
                    openAgents: this.dependencies.openAgents,
                    openGitDiff: this.dependencies.openGitDiff,
                    openModel: this.dependencies.openModel,
                    openPermissions: this.dependencies.openPermissions,
                });
                if (handled) return true;
            }
            await this.dependencies.runTurn(input, controller.signal);
            return true;
        } catch (error) {
            if (!controller.signal.aborted) {
                this.dependencies.onUnexpectedError(error);
            }
            return true;
        } finally {
            try {
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
            } catch (error) {
                this.dependencies.onUnexpectedError(error);
            } finally {
                this.resolveActiveTurn?.();
                this.resolveActiveTurn = null;
                this.activeTurnSettled = null;
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

    async waitForSettled(): Promise<void> {
        while (this.activeTurnSettled || this.immediateSlashSettled) {
            const pending = [
                this.activeTurnSettled,
                this.immediateSlashSettled,
            ].filter((item): item is Promise<void> => item !== null);
            await Promise.all(pending);
        }
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
        const operation = this.dependencies.slashCommands.process(input, {
            history,
            ctx,
            onEvent: this.dependencies.onEvent,
            openResume: this.dependencies.openResume,
            openRewind: this.dependencies.openRewind,
            openAgents: this.dependencies.openAgents,
            openGitDiff: this.dependencies.openGitDiff,
            openModel: this.dependencies.openModel,
            openPermissions: this.dependencies.openPermissions,
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
            if (this.immediateSlashSettled === operation) {
                this.immediateSlashSettled = null;
            }
        });
        this.immediateSlashSettled = operation;
        void operation;
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
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // UI subscriber 不能破坏 Turn 生命周期。
            }
        }
    }
}
