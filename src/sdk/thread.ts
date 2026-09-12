import {importSelectedImages} from "../runtime/imageInput.js";
import {createCompactState} from "../context/index.js";
import {createInitialHistory} from "../prompt/index.js";
import {createSessionId, type LoadedSession} from "../session/index.js";
import {snapshotTurnInput, importUserInput, type TurnInput} from "../images/input.js";
import {contentText, imageReferences, type MessageContent} from "../images/content.js";
import {supportsToolImages} from "../images/capability.js";
import {randomUUID} from "node:crypto";
import {getHookExecutionIssues, formatHookContext} from "../hooks/index.js";
import {isPermissionMode, type PermissionDecision, type PermissionMode,} from "../permissions/index.js";
import {isCollaborationMode, type CollaborationMode,} from "../collaboration/index.js";
import {normalizeTurnAbortReason} from "../runtime/abort.js";
import type {RootRuntimeResources} from "../runtime/resources.js";
import {createRootSessionRuntime, type RootSessionRuntime, type RootSessionSeed,} from "../runtime/sessionRuntime.js";
import type {ToolContextHost} from "../runtime/toolContext.js";
import {runRootTurn, type RootTurnLifecycleIssue,} from "../runtime/turnRuntime.js";
import {limitPersistedUIEvents, type PersistedUIEvent,} from "../session/index.js";
import type {Todo} from "../todos.js";
import {AsyncEventQueue} from "./eventQueue.js";
import {SDKEventAdapter} from "./eventAdapter.js";
import {normalizeInteractionResponse, raceInteractionWithAbort,} from "./interaction.js";
import type {
    InteractionRequest,
    InteractionResponse,
    ThreadEvent,
    ThreadEventPayload,
} from "./protocol.js";
import {collectTurnResult} from "./resultCollector.js";
import {
    PillarSDKError,
    type HostDiagnostic,
    type PillarHost,
    type StreamedTurn,
    type Thread,
    type ThreadInfo,
    type TurnOptions,
    type TurnResult,
} from "./types.js";

const MAX_SDK_ITERATIONS = 100;

interface SDKSessionState {
    todos: Todo[];
    permissionMode: PermissionMode;
    collaborationMode: CollaborationMode;
    uiEvents: PersistedUIEvent[];
}

interface CreateSDKThreadOptions {
    resources: RootRuntimeResources;
    seed: RootSessionSeed;
    state: SDKSessionState;
    resumed: boolean;
    host?: PillarHost;
    signal?: AbortSignal;
    onClose(): void;
}

interface SDKThreadDependencies {
    runTurn: typeof runRootTurn;
    now(): number;
}

interface ActiveRun {
    controller: AbortController;
    settled: Promise<void>;
}

export function createSDKThreadFactory(
    overrides: Partial<SDKThreadDependencies> = {}
) {
    const dependencies: SDKThreadDependencies = {
        runTurn: overrides.runTurn ?? runRootTurn,
        now: overrides.now ?? Date.now,
    };

    return async function createSDKThread(
        options: CreateSDKThreadOptions
    ): Promise<SessionThread> {
        if (options.state.permissionMode === "full-access" && !options.resources.allowFullAccess) throw new PillarSDKError("permission_mode_not_allowed", "This Host does not allow Full Access");
        const session = createRootSessionRuntime({
            resources: options.resources,
            seed: options.seed,
            allowBackgroundTasks: false,
        });
        await session.initialize();
        try {
            const sessionStart = await session.runSessionStart(
                options.resumed ? "resume" : "startup",
                options.signal ?? new AbortController().signal
            );
            await reportHookIssues(options.host, sessionStart);
            return new SDKThreadImpl({
                ...options,
                session,
                sessionStartContextBlocks: formatHookContext(
                    "SessionStart",
                    sessionStart.additionalContexts
                ),
                dependencies,
            });
        } catch (error) {
            try {await reportHookIssues(options.host, await session.runSessionEnd("error"));}
            catch { /* Preserve the initialization failure; Root stays owned by its creator. */ }
            throw error;
        }
    };
}

interface SDKThreadImplOptions extends CreateSDKThreadOptions {
    session: RootSessionRuntime;
    sessionStartContextBlocks: readonly string[];
    dependencies: SDKThreadDependencies;
}

interface SessionThread extends Thread {
    runStreamedWithImagePaths(input: string, paths: readonly string[], options?: TurnOptions): Promise<StreamedTurn>;
}

class SDKThreadImpl implements SessionThread {
    readonly id: string;
    private sequence = 0;
    private activeRun: ActiveRun | undefined;
    private emittedThreadStarted: boolean;
    private closePromise: Promise<void> | undefined;
    private closed = false;
    private preparing: {controller: AbortController; settled: Promise<MessageContent>} | undefined;
    private lastEndReason = "shutdown";

    constructor(private readonly options: SDKThreadImplOptions) {
        this.id = options.session.sessionId;
        this.emittedThreadStarted = options.resumed;
    }

    getInfo(): ThreadInfo {
        return {
            id: this.id,
            cwd: this.options.resources.cwd,
            model: this.options.resources.model,
            provider: this.options.resources.provider,
            permissionMode: this.options.state.permissionMode,
            collaborationMode: this.options.state.collaborationMode,
            sandbox: this.options.resources.sandbox.status,
            mcpServers:
                this.options.resources.mcpManager?.getSnapshots() ?? [],
            resumed: this.options.resumed,
        };
    }

    async run(
        input: TurnInput,
        options: TurnOptions = {}
    ): Promise<TurnResult> {
        const streamed = await this.runStreamed(input, options);
        return collectTurnResult(streamed.events);
    }

    async runStreamed(
        input: TurnInput,
        options: TurnOptions = {}
    ): Promise<StreamedTurn> {
        validateTurnOptions(options);
        if (this.closed) throw new PillarSDKError("thread_closed", `Thread is closed: ${this.id}`);
        if (this.activeRun || this.preparing) throw new PillarSDKError("thread_busy", `Thread already has an active Turn: ${this.id}`);
        let copied: TurnInput;
        try {copied = snapshotTurnInput(input);} catch (error) {throw new PillarSDKError("invalid_input", error instanceof Error ? error.message : String(error));}
        if (typeof copied === "string") return {events: this.streamTurn(copied, options)};
        const resources = this.options.resources;
        const target = resources.primaryModel.target;
        return this.prepareImageInput(signal => importUserInput(copied, this.options.session.toolResultStore,
            supportsToolImages(resources.settings.sources[target.source], target.model), signal), options);
    }

    async runStreamedWithImagePaths(input: string, paths: readonly string[], options: TurnOptions = {}): Promise<StreamedTurn> {
        if (!paths.length) return this.runStreamed(input, options);
        return this.prepareImageInput(async signal => {
            const images = await importSelectedImages(paths, this.options.resources, this.options.session.createContext({
                signal, host: this.createToolContextHost(randomUUID(), undefined, signal),
                onEvent: () => {}, getSnapshotState: () => ({...this.options.state}),
            }));
            return [{type: "text", text: input}, ...images];
        }, options);
    }

    private async prepareImageInput(prepare: (signal: AbortSignal) => Promise<MessageContent>, options: TurnOptions): Promise<StreamedTurn> {
        validateTurnOptions(options);
        if (this.closed) throw new PillarSDKError("thread_closed", `Thread is closed: ${this.id}`);
        if (this.activeRun || this.preparing) throw new PillarSDKError("thread_busy", `Thread already has an active Turn: ${this.id}`);
        const controller = new AbortController();
        const unlink = linkAbortSignal(options.signal, controller);
        const settled = prepare(controller.signal);
        const preparing = {controller, settled};
        this.preparing = preparing;
        try {
            const prompt = await settled;
            if (this.closed || controller.signal.aborted) throw new PillarSDKError("interrupted", "Image input cancelled");
            return {events: this.streamTurn(prompt, options)};
        } catch (error) {
            throw new PillarSDKError(controller.signal.aborted ? "interrupted" : "invalid_image",
                controller.signal.aborted ? "Image input cancelled" : error instanceof Error ? error.message : String(error));
        } finally {unlink(); if (this.preparing === preparing) this.preparing = undefined;}
    }

    close(): Promise<void> {
        this.closePromise ??= this.closeInternal();
        return this.closePromise;
    }

    private async *streamTurn(
        prompt: MessageContent,
        turnOptions: TurnOptions
    ): AsyncGenerator<ThreadEvent> {
        if (this.closed) {
            throw new PillarSDKError(
                "thread_closed",
                `Thread is closed: ${this.id}`
            );
        }
        if (this.activeRun) {
            throw new PillarSDKError(
                "thread_busy",
                `Thread already has an active Turn: ${this.id}`
            );
        }

        const turnId = randomUUID();
        const controller = new AbortController();
        const queue = new AsyncEventQueue(() => controller.abort("user-cancel"));
        let cancelTimer: ReturnType<typeof setTimeout> | undefined;
        const expireCancelledStream = () => {
            cancelTimer ??= setTimeout(() => queue.discard(new Error("SDK consumer did not receive cancellation events in time; event stream disconnected")), 1_000);
        };
        controller.signal.addEventListener("abort", expireCancelledStream, {once: true});
        const removeExternalAbort = linkAbortSignal(
            turnOptions.signal,
            controller
        );
        let executionCompleted = false;
        const execution = this.executeTurn(
            prompt,
            turnId,
            turnOptions,
            controller,
            queue
        ).finally(() => {
            executionCompleted = true;
            removeExternalAbort();
            controller.signal.removeEventListener("abort", expireCancelledStream);
            if (cancelTimer !== undefined) clearTimeout(cancelTimer);
            queue.close();
        });
        this.activeRun = {controller, settled: execution};

        try {
            for await (const event of queue.iterate()) {
                yield {...event, sequence: ++this.sequence};
            }
        } finally {
            queue.discard();
            if (!executionCompleted && !controller.signal.aborted) {
                controller.abort("user-cancel");
            }
            try {await execution;} finally {
                if (this.activeRun?.controller === controller) this.activeRun = undefined;
            }
        }
    }

    private async executeTurn(
        prompt: MessageContent,
        turnId: string,
        turnOptions: TurnOptions,
        controller: AbortController,
        queue: AsyncEventQueue
    ): Promise<void> {
        const startedAt = this.options.dependencies.now();
        const emit = (payload: ThreadEventPayload): Promise<void> => {
            return queue.push({
                ...payload,
                protocolVersion: 1,
                sequence: 0,
                threadId: this.id,
                emittedAt: new Date().toISOString(),
            } as ThreadEvent);
        };
        if (!this.emittedThreadStarted) {
            this.emittedThreadStarted = true;
            await emit({type: "thread.started"});
        }
        await emit({
            type: "turn.started",
            turnId,
            inputSummary: boundedInputSummary(contentText(prompt)),
            ...(imageReferences(prompt).length ? {images: imageReferences(prompt)} : {}),
        });
        const adapter = new SDKEventAdapter(turnId, emit);
        if ((turnOptions.permissionMode ?? this.options.state.permissionMode) === "full-access" && !this.options.resources.allowFullAccess) throw new PillarSDKError("permission_mode_not_allowed", "This Host does not allow Full Access");
        if (turnOptions.permissionMode !== undefined || turnOptions.collaborationMode !== undefined) this.options.session.invalidateApprovals();
        if (turnOptions.permissionMode !== undefined) {
            this.options.state.permissionMode = turnOptions.permissionMode;
        }
        if (turnOptions.collaborationMode !== undefined) {
            this.options.state.collaborationMode = turnOptions.collaborationMode;
        }

        try {
            const result = await this.options.dependencies.runTurn({
                turnId,
                resources: this.options.resources,
                session: this.options.session,
                prompt,
                signal: controller.signal,
                host: this.createToolContextHost(turnId, adapter, controller.signal),
                onEvent: adapter.handleAgentEvent,
                onHookResult: async (hookResult) => {
                    for (const issue of getHookExecutionIssues(hookResult)) {
                        await adapter.emitDiagnostic("hook", issue);
                        await this.reportDiagnostic({
                            severity: "warning",
                            scope: "hook",
                            message: issue,
                        });
                    }
                },
                onLifecycleIssue: async (issue) => {
                    await this.reportLifecycleIssue(adapter, issue);
                },
                getSnapshotState: () => ({
                    todos: this.options.state.todos,
                    permissionMode: this.options.state.permissionMode,
                    collaborationMode: this.options.state.collaborationMode,
                    uiEvents: limitPersistedUIEvents([
                        ...this.options.state.uiEvents,
                        ...adapter.getPersistedUIEvents(),
                    ]),
                }),
                sessionStartContextBlocks:
                    this.options.sessionStartContextBlocks,
                maxIterations: turnOptions.maxIterations,
            });
            await adapter.finish(result.reason);
            this.commitUIEvents(adapter);
            this.lastEndReason = result.reason;
            await emit({
                type: "turn.completed",
                turnId,
                usage: result.usage ?? null,
                stopReason: result.reason,
                abortReason: result.abortReason,
                iterations: result.iterations,
                durationMs: Math.max(
                    0,
                    this.options.dependencies.now() - startedAt
                ),
            });
        } catch (error) {
            const interrupted = controller.signal.aborted;
            this.lastEndReason = interrupted ? "interrupted" : "error";
            await adapter.finish(interrupted ? "interrupted" : "max_turns");
            this.commitUIEvents(adapter);
            const info = toSDKErrorInfo(error, controller.signal);
            await emit({type: "turn.failed", turnId, error: info});
        }
    }

    private createToolContextHost(
        turnId: string,
        adapter: SDKEventAdapter | undefined,
        ownerSignal: AbortSignal
    ): ToolContextHost {
        return {
            canUseTool: async (toolName, message, input, options) => {
                const network = options?.presentation?.kind === "network_access"
                    ? options.presentation : undefined;
                const signal = options?.signal
                    ? AbortSignal.any([ownerSignal, options.signal])
                    : ownerSignal;
                const request: InteractionRequest = toolName === "ask_user"
                    ? {
                        requestId: randomUUID(),
                        kind: "question",
                        toolName,
                        message,
                        input,
                    }
                    : {
                        requestId: randomUUID(),
                        kind: "permission",
                        toolName,
                        message,
                        input,
                        ...(network ? {networkAccess: {host: network.host, port: network.port}} : {}),
                    };
                await adapter?.emitInteractionStart(request);
                let response = await this.requestInteraction(
                    request,
                    turnId,
                    signal
                );
                if (network && response.behavior === "allow" && (
                    response.persistence === "always" || response.directoryScope !== undefined ||
                    response.answers !== undefined
                )) {
                    response = {behavior: "deny", message: "Network connections do not support permanent tool grants, directory grants or input changes"};
                }
                const status = signal.aborted
                    ? "interrupted"
                    : response.behavior === "deny"
                        ? "denied"
                        : "completed";
                await adapter?.emitInteractionEnd(request, response, status);
                return toPermissionDecision(response);
            },
            getPermissionRules: () =>
                this.options.resources.settings.permissions.rules,
            getPermissionMode: () => this.options.state.permissionMode,
            getCollaborationMode: () => this.options.state.collaborationMode,
            getPermissionPromptPolicy: () =>
                this.options.host?.onInteraction ? "onRequest" : "never",
            setTodos: async (todos) => {
                this.options.state.todos = todos;
                await adapter?.emitTodos(todos);
            },
        };
    }

    private async requestInteraction(
        request: InteractionRequest,
        turnId: string,
        signal: AbortSignal
    ): Promise<InteractionResponse> {
        const callback = this.options.host?.onInteraction;
        if (!callback) {
            return {
                behavior: "deny",
                message: "SDK Host did not provide onInteraction; interaction-required operation denied",
            };
        }
        try {
            const response = await raceInteractionWithAbort(
                requestSignal => callback(request, {
                    signal: requestSignal,
                    cwd: this.options.resources.cwd,
                    threadId: this.id,
                    turnId,
                }),
                signal
            );
            return normalizeInteractionResponse(response);
        } catch (error) {
            return {
                behavior: "deny",
                message: signal.aborted
                    ? "Turn cancelled"
                    : `SDK Host interaction failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    private commitUIEvents(adapter: SDKEventAdapter): void {
        this.options.state.uiEvents = limitPersistedUIEvents([
            ...this.options.state.uiEvents,
            ...adapter.getPersistedUIEvents(),
        ]);
    }

    private async reportLifecycleIssue(
        adapter: SDKEventAdapter,
        issue: RootTurnLifecycleIssue
    ): Promise<void> {
        const message = `${issue.message}: ${issue.error instanceof Error ? issue.error.message : String(issue.error)}`;
        await adapter.emitDiagnostic(issue.scope, message, "error");
        await this.reportDiagnostic({
            severity: "error",
            scope: issue.scope === "host" ? "runtime" : issue.scope,
            message,
        });
    }

    private async reportDiagnostic(diagnostic: HostDiagnostic): Promise<void> {
        try {
            await this.options.host?.onDiagnostic?.(diagnostic);
        } catch {
            // Host diagnostic sinks cannot alter the Turn lifecycle.
        }
    }

    private async closeInternal(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const preparing = this.preparing;
        preparing?.controller.abort("shutdown");
        await preparing?.settled.catch(() => undefined);
        const active = this.activeRun;
        if (active && !active.controller.signal.aborted) {
            active.controller.abort("shutdown");
        }
        try {
            await active?.settled;
            try {
                const result = await this.options.session.runSessionEnd(
                    this.lastEndReason
                );
                await reportHookIssues(this.options.host, result);
            } catch (error) {
                await this.reportDiagnostic({
                    severity: "warning",
                    scope: "hook",
                    message: `SessionEnd failed: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
            await this.options.session.saveSnapshot(
                this.options.session.createSnapshot({
                    todos: this.options.state.todos,
                    permissionMode: this.options.state.permissionMode,
                    collaborationMode: this.options.state.collaborationMode,
                    uiEvents: this.options.state.uiEvents,
                })
            );
        } finally {
            this.options.onClose();
        }
    }
}

export const createSDKThread = createSDKThreadFactory();

function validateTurnOptions(options: TurnOptions): void {
    if (
        options.permissionMode !== undefined &&
        !isPermissionMode(options.permissionMode)
    ) {
        throw new PillarSDKError(
            "invalid_permission_mode",
            `Invalid permissionMode: ${String(options.permissionMode)}`
        );
    }
    if (
        options.collaborationMode !== undefined &&
        !isCollaborationMode(options.collaborationMode)
    ) {
        throw new PillarSDKError(
            "invalid_collaboration_mode",
            `Invalid collaborationMode: ${String(options.collaborationMode)}`
        );
    }
    if (
        options.maxIterations !== undefined &&
        (!Number.isInteger(options.maxIterations) ||
            options.maxIterations < 1 ||
            options.maxIterations > MAX_SDK_ITERATIONS)
    ) {
        throw new PillarSDKError(
            "invalid_max_iterations",
            `maxIterations must be an integer from 1 to ${MAX_SDK_ITERATIONS} .`
        );
    }
}

function boundedInputSummary(input: string): string {
    const oneLine = input.replace(/\s+/g, " ").trim();
    return oneLine.length <= 240
        ? oneLine
        : `${oneLine.slice(0, 239)}…`;
}

function toPermissionDecision(
    response: InteractionResponse
): PermissionDecision {
    return response.behavior === "allow"
        ? {
            behavior: "allow",
            ...(response.networkScope === undefined ? {} : {networkScope: response.networkScope}),
            ...(response.directoryScope === undefined
                ? {}
                : {directoryScope: response.directoryScope}),
            ...(response.answers === undefined
                ? {}
                : {answers: response.answers}),
        }
        : {behavior: "deny", message: response.message};
}

function linkAbortSignal(
    external: AbortSignal | undefined,
    controller: AbortController
): () => void {
    if (!external) return () => {};
    const abort = () => {
        if (!controller.signal.aborted) {
            controller.abort(external.reason ?? "user-cancel");
        }
    };
    if (external.aborted) abort();
    else external.addEventListener("abort", abort, {once: true});
    return () => external.removeEventListener("abort", abort);
}

function toSDKErrorInfo(
    error: unknown,
    signal: AbortSignal
): {code: string; message: string} {
    if (error instanceof PillarSDKError) {
        return {code: error.code, message: error.message};
    }
    if (signal.aborted) {
        return {
            code: "turn_interrupted",
            message: `Turn cancelled: ${normalizeTurnAbortReason(signal.reason)}`,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {code: "runtime_error", message: message.slice(0, 1_000)};
}

async function reportHookIssues(
    host: PillarHost | undefined,
    result: Parameters<typeof getHookExecutionIssues>[0]
): Promise<void> {
    for (const execution of result.executions) {
        if (!execution.userMessage) continue;
        try {
            await host?.onDiagnostic?.({severity: "info", scope: "hook", message: execution.userMessage});
        } catch {
            // Session notifications are independent of the Host diagnostic sink.
        }
    }
    for (const issue of getHookExecutionIssues(result)) {
        try {
            await host?.onDiagnostic?.({
                severity: "warning",
                scope: "hook",
                message: issue,
            });
        } catch {
            // Host diagnostic sinks cannot disrupt the Session lifecycle.
        }
    }
}

/** Shared startup/resume projection for SDK and the single-run CLI host. */
export function prepareThreadSession(resources: RootRuntimeResources, loaded?: LoadedSession) {
    return {
        seed: {
            sessionId: loaded?.sessionId ?? createSessionId(),
            history: loaded?.history ?? createInitialHistory(resources.cwd, resources.model),
            compactState: loaded?.compactState ?? createCompactState(),
            queuedInputs: loaded?.queuedInputs,
            taskNotificationReceipts: loaded?.taskNotificationReceipts,
            toolDiscovery: loaded?.toolDiscovery,
        },
        state: {
            todos: loaded?.todos ?? [],
            permissionMode: loaded?.permissionMode ?? resources.settings.permissions.defaultMode,
            collaborationMode: loaded?.collaborationMode ?? "build" as const,
            uiEvents: loaded?.uiEvents ?? [],
        },
        resumed: loaded !== undefined,
    };
}
