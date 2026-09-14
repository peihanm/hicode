import {imageReferences, IMAGE_MAX_COUNT, IMAGE_REQUEST_BYTES, type ImageReference, type MessageContent} from "../../images/content.js";
import type {AgentEvent} from "../../agent/types.js";
import type {CollaborationMode} from "../../collaboration/index.js";
import type {Message} from "../../llm/types.js";
import type {ToolContext} from "../../tools/types.js";
import type {SlashCommandProcessor} from "../../slash/types.js";
import {createTurnAbortController, type TurnAbortReason,} from "../../runtime/abort.js";
import {QueryGuard} from "./queryGuard.js";
import {RuntimeMessageQueue} from "../../runtime/messageQueue.js";
import type {ToolRuntime} from "../../tools/runtime.js";
import {randomUUID} from "node:crypto";

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

    onUserInput(input: MessageContent): void;

    onEvent(event: AgentEvent): void;

    onUnexpectedError(error: unknown): void;

    denyPendingPermission(message: string): void;

    slashCommands: SlashCommandProcessor;

    initialize(): Promise<void>;

    openResume?(): void;
    openAgents?(): void;
    openTasks?(): void;
    toolRuntime: Pick<ToolRuntime, "executeTool">;

    openGitDiff?(): void;
    openModel?(): void;
    openProviders?(): void;
    openPermissions?(): void;
    setCollaborationMode?(mode: CollaborationMode): void;

    runTurn(input: MessageContent, signal: AbortSignal): Promise<void>;

    importImages(paths: readonly string[], signal: AbortSignal): Promise<ImageReference[]>;
    validateImages(content: MessageContent): void;
    restoreDraft(text: string): void;
    messageQueue: RuntimeMessageQueue;

    now(): number;
}

const IDLE_STATUS: UITurnStatus = {busy: false, stopping: false};

export class UITurnController {
    private readonly taskActions = new Map<AbortController, Promise<void>>();

    async stopTask(id: string): Promise<void> {
        if (this.disposed) throw new Error("Session is closing");
        if (this.taskActions.size) throw new Error("Another task operation is in progress");
        const controller = createTurnAbortController();
        const operation = (async () => {
            await this.dependencies.initialize();
            const result = await this.dependencies.toolRuntime.executeTool("task", JSON.stringify({action: "stop", task_id: id}),
                this.dependencies.createContext(controller.signal), `ui-task-${randomUUID()}`);
            if (result.outcome !== "ok") throw new Error(result.displayContent);
        })();
        this.taskActions.set(controller, operation);
        try {await operation;} finally {this.taskActions.delete(controller);}
    }
    private readonly guard = new QueryGuard();
    private readonly listeners = new Set<Listener>();
    private active: { generation: number; controller: AbortController } | null = null;
    private activeTurnSettled: Promise<void> | null = null;
    private resolveActiveTurn: (() => void) | null = null;
    private immediateSlashController: AbortController | null = null;
    private immediateSlashSettled: Promise<void> | null = null;
    private snapshot: UITurnStatus = IDLE_STATUS;
    private disposed = false;
    private attachmentState: {images: readonly ImageReference[]; preparing: boolean} = {images: [], preparing: false};
    private imageImport: {controller: AbortController; settled: Promise<void>} | undefined;
    getAttachmentSnapshot = () => this.attachmentState;

    private setAttachments(images: readonly ImageReference[], preparing = false): void {
        this.attachmentState = {images: structuredClone(images), preparing};
        for (const listener of this.listeners) {try {listener();} catch {}}
    }

    restoreAttachments(content: MessageContent): string {
        this.setAttachments(imageReferences(content));
        return typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
    }

    removeAttachment(target: number | "last" | "all"): void {
        if (this.disposed || this.imageImport) return;
        if (target === "all") this.setAttachments([]);
        else {
            const index = target === "last" ? this.attachmentState.images.length - 1 : target;
            if (!Number.isInteger(index) || index < 0 || index >= this.attachmentState.images.length) return;
            this.setAttachments(this.attachmentState.images.filter((_, position) => position !== index));
        }
    }

    async addImages(paths: readonly string[]): Promise<void> {
        await this.prepareImages(paths.length, signal => this.dependencies.importImages(paths, signal));
    }

    pasteImage(path: string, originalText: string): boolean {
        if (this.disposed || this.imageImport) return false;
        void this.prepareImages(1, signal => this.dependencies.importImages([path], signal)).then(imported => {
            if (!imported && !this.disposed) this.dependencies.restoreDraft(originalText);
        });
        return true;
    }

    private async prepareImages(count: number, prepare: (signal: AbortSignal) => Promise<ImageReference[]>): Promise<boolean> {
        if (this.disposed || this.imageImport) return false;
        if (count + this.attachmentState.images.length > IMAGE_MAX_COUNT) {this.dependencies.onUnexpectedError(new Error("Up to 8 images may be attached")); return false;}
        const controller = createTurnAbortController();
        this.setAttachments(this.attachmentState.images, true);
        const settled = (async () => {
            try {
                await this.dependencies.initialize();
                const images = await prepare(controller.signal);
                if (controller.signal.aborted || this.disposed) return false;
                const all = [...this.attachmentState.images, ...images];
                if (all.reduce((sum, ref) => sum + ref.image.byteLength, 0) > IMAGE_REQUEST_BYTES) throw new Error("Attachments exceed the 10 MiB budget");
                this.setAttachments(all);
                return true;
            } catch (error) {if (!controller.signal.aborted) this.dependencies.onUnexpectedError(error); return false;}
            finally {this.setAttachments(this.attachmentState.images); this.imageImport = undefined;}
        })();
        this.imageImport = {controller, settled: settled.then(() => {})};
        return await settled;
    }

    private withAttachments(input: string): MessageContent {
        return this.attachmentState.images.length ? [{type: "text", text: input}, ...this.attachmentState.images] : input;
    }

    async submit(input: string): Promise<boolean> {
        if (this.imageImport) return false;
        // Slash commands do not consume the pending prompt's attachments.
        const content = input.trim().startsWith("/") ? input : this.withAttachments(input);
        try {
            const images = imageReferences(content);
            if (images.length > IMAGE_MAX_COUNT || images.reduce((sum, ref) => sum + ref.image.byteLength, 0) > IMAGE_REQUEST_BYTES) throw new Error("Attachments exceed 8 images or 10 MiB; remove some images with Backspace in the input");
            this.dependencies.validateImages(content);
        } catch (error) {
            this.dependencies.restoreDraft(input); this.dependencies.onUnexpectedError(error); return false;
        }
        if (this.disposed || this.snapshot.busy) return false;
        if (Array.isArray(content)) this.setAttachments([]);
        return this.submitPrepared(content);
    }

    constructor(private readonly dependencies: UITurnControllerDependencies) {
    }

    private now(): number {
        return this.dependencies.now();
    }

    private async submitPrepared(input: MessageContent): Promise<boolean> {
        if (this.disposed || !this.guard.reserve()) return false;
        const isSlash = typeof input === "string" && input.trim().startsWith("/");
        this.publish({busy: true, stopping: false, ...(isSlash ? {} : {startedAt: this.now()})});

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

            if (typeof input === "string" && input.trim().startsWith("/")) {
                const ctx = this.dependencies.createContext(controller.signal);
                const handled = await this.dependencies.slashCommands.process(input, {
                    history,
                    ctx,
                    onEvent: this.dependencies.onEvent,
                    openResume: this.dependencies.openResume,
                    openAgents: this.dependencies.openAgents,
                    openTasks: this.dependencies.openTasks,
                    openGitDiff: this.dependencies.openGitDiff,
                    openModel: this.dependencies.openModel,
                    openProviders: this.dependencies.openProviders,
                    openPermissions: this.dependencies.openPermissions,
                    setCollaborationMode: this.dependencies.setCollaborationMode,
                });
                if (handled) return true;
            }
            if (isSlash) this.publish({busy: true, stopping: false, startedAt: this.now()});
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
                            void this.submitPrepared(next.content);
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
            const content = trimmed.startsWith("/") ? trimmed : this.withAttachments(trimmed);
            this.dependencies.validateImages(content);
            this.dependencies.messageQueue.enqueueUser(
                content,
                trimmed.startsWith("/") ? "later" : "next"
            );
            if (Array.isArray(content)) this.setAttachments([]);
            return true;
        } catch (error) {
            this.dependencies.restoreDraft(input);
            this.dependencies.onUnexpectedError(error);
            return false;
        }
    }

    cancel(reason: TurnAbortReason = "user-cancel"): boolean {
        if (this.imageImport) {this.imageImport.controller.abort(reason); return true;}
        const active = this.active;
        if (!active || active.controller.signal.aborted) return false;
        this.publish({...this.snapshot, busy: true, stopping: true});
        active.controller.abort(reason);
        this.dependencies.denyPendingPermission("Task cancelled");
        return true;
    }

    takeQueuedInputsForEditing(
        currentInput: string,
        currentCursorOffset: number
    ): RestoredQueuedDraft | undefined {
        const queuedInputs = this.dependencies.messageQueue.takeEditableInputs();
        if (queuedInputs.length === 0) return undefined;
        const images = [...queuedInputs.flatMap(imageReferences), ...this.attachmentState.images];
        this.setAttachments(images);
        const queuedText = queuedInputs.map(content => typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
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
        for (const controller of this.taskActions.keys()) controller.abort("shutdown");
        this.imageImport?.controller.abort("shutdown");
        const active = this.active;
        if (active && !active.controller.signal.aborted) {
            active.controller.abort("shutdown");
        }
        this.immediateSlashController?.abort("shutdown");
        this.immediateSlashController = null;
        this.dependencies.denyPendingPermission("Application is shutting down");
        this.listeners.clear();
    }

    async waitForSettled(): Promise<void> {
        while (this.activeTurnSettled || this.immediateSlashSettled || this.imageImport || this.taskActions.size) {
            const pending = [
                this.imageImport?.settled ?? null,
                this.activeTurnSettled,
                this.immediateSlashSettled,
            ].filter((item): item is Promise<void> => item !== null);
            await Promise.allSettled([...pending, ...this.taskActions.values()]);
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
            openAgents: this.dependencies.openAgents,
            openTasks: this.dependencies.openTasks,
            openGitDiff: this.dependencies.openGitDiff,
            openModel: this.dependencies.openModel,
            openPermissions: this.dependencies.openPermissions,
                    setCollaborationMode: this.dependencies.setCollaborationMode,
        }).then((result) => {
            if (result !== true) {
                throw new Error(`Running Slash did not finish as a local command: ${input}`);
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
                // UI subscribers cannot disrupt the Turn lifecycle.
            }
        }
    }
}
