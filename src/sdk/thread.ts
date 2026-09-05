import {randomUUID} from "node:crypto";
import {getHookExecutionIssues, formatHookContext} from "../hooks/index.js";
import {isPermissionMode, type PermissionDecision, type PermissionMode,} from "../permissions/index.js";
import {isCollaborationMode, type CollaborationMode,} from "../collaboration/index.js";
import {normalizeTurnAbortReason} from "../runtime/abort.js";
import type {RootRuntimeResources} from "../runtime/resources.js";
import {createRootSessionRuntime, type RootSessionRuntime, type RootSessionSeed,} from "../runtime/sessionRuntime.js";
import type {ToolContextHost} from "../runtime/toolContext.js";
import {runRootTurn, type RootTurnLifecycleIssue,} from "../runtime/turnRuntime.js";
import {limitPersistedUIEvents, saveSessionSnapshot, type PersistedUIEvent,} from "../session/index.js";
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

const MAX_INPUT_CHARACTERS = 1_000_000;
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
    saveSession: typeof saveSessionSnapshot;
    now(): number;
}

interface ActiveRun {
    controller: AbortController;
    settled: Promise<void>;
}

function createSDKThreadFactory(
    overrides: Partial<SDKThreadDependencies> = {}
) {
    const dependencies: SDKThreadDependencies = {
        runTurn: overrides.runTurn ?? runRootTurn,
        saveSession: overrides.saveSession ?? saveSessionSnapshot,
        now: overrides.now ?? Date.now,
    };

    return async function createSDKThread(
        options: CreateSDKThreadOptions
    ): Promise<Thread> {
        const session = createRootSessionRuntime({
            resources: options.resources,
            seed: options.seed,
            resumed: options.resumed,
            allowBackgroundTasks: false,
        });
        await session.initialize();
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
    };
}

interface SDKThreadImplOptions extends CreateSDKThreadOptions {
    session: RootSessionRuntime;
    sessionStartContextBlocks: readonly string[];
    dependencies: SDKThreadDependencies;
}

class SDKThreadImpl implements Thread {
    readonly id: string;
    private sequence = 0;
    private activeRun: ActiveRun | undefined;
    private emittedThreadStarted: boolean;
    private closePromise: Promise<void> | undefined;
    private closed = false;
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
        input: string,
        options: TurnOptions = {}
    ): Promise<TurnResult> {
        const streamed = await this.runStreamed(input, options);
        return collectTurnResult(streamed.events);
    }

    async runStreamed(
        input: string,
        options: TurnOptions = {}
    ): Promise<StreamedTurn> {
        const prompt = validateInput(input);
        validateTurnOptions(options);
        return {events: this.streamTurn(prompt, options)};
    }

    close(): Promise<void> {
        this.closePromise ??= this.closeInternal();
        return this.closePromise;
    }

    private async *streamTurn(
        prompt: string,
        turnOptions: TurnOptions
    ): AsyncGenerator<ThreadEvent> {
        if (this.closed) {
            throw new PillarSDKError(
                "thread_closed",
                `Thread 已关闭: ${this.id}`
            );
        }
        if (this.activeRun) {
            throw new PillarSDKError(
                "thread_busy",
                `Thread 已有 Turn 正在运行: ${this.id}`
            );
        }

        const turnId = randomUUID();
        const queue = new AsyncEventQueue<ThreadEvent>();
        const controller = new AbortController();
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
            queue.close();
            if (this.activeRun?.controller === controller) {
                this.activeRun = undefined;
            }
        });
        this.activeRun = {controller, settled: execution};

        try {
            yield* queue.iterate();
        } finally {
            if (!executionCompleted && !controller.signal.aborted) {
                controller.abort("user-cancel");
            }
            await execution;
        }
    }

    private async executeTurn(
        prompt: string,
        turnId: string,
        turnOptions: TurnOptions,
        controller: AbortController,
        queue: AsyncEventQueue<ThreadEvent>
    ): Promise<void> {
        const startedAt = this.options.dependencies.now();
        const emit = (payload: ThreadEventPayload): void => {
            this.sequence += 1;
            queue.push({
                ...payload,
                protocolVersion: 1,
                sequence: this.sequence,
                threadId: this.id,
                emittedAt: new Date().toISOString(),
            } as ThreadEvent);
        };
        if (!this.emittedThreadStarted) {
            this.emittedThreadStarted = true;
            emit({type: "thread.started"});
        }
        emit({
            type: "turn.started",
            turnId,
            inputSummary: boundedInputSummary(prompt),
        });
        const adapter = new SDKEventAdapter(turnId, emit);
        if (turnOptions.permissionMode !== undefined) {
            this.options.state.permissionMode = turnOptions.permissionMode;
        }
        if (turnOptions.collaborationMode !== undefined) {
            this.options.state.collaborationMode = turnOptions.collaborationMode;
        }

        try {
            const result = await this.options.dependencies.runTurn({
                resources: this.options.resources,
                session: this.options.session,
                prompt,
                signal: controller.signal,
                host: this.createToolContextHost(turnId, adapter, controller),
                onEvent: adapter.handleAgentEvent,
                onHookResult: async (hookResult) => {
                    for (const issue of getHookExecutionIssues(hookResult)) {
                        adapter.emitDiagnostic("hook", issue);
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
            adapter.finish(result.reason);
            this.commitUIEvents(adapter);
            this.lastEndReason = result.reason;
            const checkpointId =
                this.options.session.fileCheckpoints.getHead().checkpointId;
            emit({
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
                checkpointId,
            });
        } catch (error) {
            const interrupted = controller.signal.aborted;
            adapter.finish(interrupted ? "interrupted" : "max_turns");
            this.commitUIEvents(adapter);
            const info = toSDKErrorInfo(error, controller.signal);
            emit({type: "turn.failed", turnId, error: info});
        }
    }

    private createToolContextHost(
        turnId: string,
        adapter: SDKEventAdapter,
        controller: AbortController
    ): ToolContextHost {
        return {
            canUseTool: async (toolName, message, input, options) => {
                const network = options?.presentation?.kind === "network_access"
                    ? options.presentation : undefined;
                const signal = options?.signal
                    ? AbortSignal.any([controller.signal, options.signal])
                    : controller.signal;
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
                adapter.emitInteractionStart(request);
                let response = await this.requestInteraction(
                    request,
                    turnId,
                    signal
                );
                if (network && response.behavior === "allow" && (
                    response.persistence === "always" || response.directoryScope !== undefined ||
                    response.answers !== undefined
                )) {
                    response = {behavior: "deny", message: "网络连接不支持永久工具授权、目录授权或修改输入"};
                }
                const status = signal.aborted
                    ? "interrupted"
                    : response.behavior === "deny"
                        ? "denied"
                        : "completed";
                adapter.emitInteractionEnd(request, response, status);
                return toPermissionDecision(response);
            },
            getPermissionRules: () =>
                this.options.resources.settings.permissions.rules,
            getPermissionMode: () => this.options.state.permissionMode,
            getCollaborationMode: () => this.options.state.collaborationMode,
            getPermissionPromptPolicy: () =>
                this.options.host?.onInteraction ? "onRequest" : "never",
            setPermissionMode: (mode) => {
                this.options.state.permissionMode = mode;
            },
            setCollaborationMode: (mode) => {
                this.options.state.collaborationMode = mode;
            },
            setTodos: (todos) => {
                this.options.state.todos = todos;
                adapter.emitTodos(todos);
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
                message: "SDK Host 未提供 onInteraction，已拒绝需要交互的操作",
            };
        }
        try {
            const response = await raceInteractionWithAbort(
                callback(request, {
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
                    ? "Turn 已取消"
                    : `SDK Host interaction 失败: ${error instanceof Error ? error.message : String(error)}`,
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
        adapter.emitDiagnostic(issue.scope, message, "error");
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
            // Host diagnostic sink 不能改变 Turn 生命周期。
        }
    }

    private async closeInternal(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
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
                    message: `SessionEnd 执行失败: ${error instanceof Error ? error.message : String(error)}`,
                });
            }
            await this.options.dependencies.saveSession(
                this.options.resources.storage,
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

function validateInput(input: string): string {
    if (typeof input !== "string") {
        throw new PillarSDKError("invalid_input", "SDK Turn input 必须是字符串");
    }
    const trimmed = input.trim();
    if (!trimmed) {
        throw new PillarSDKError("invalid_input", "SDK Turn input 不能为空");
    }
    if (input.length > MAX_INPUT_CHARACTERS) {
        throw new PillarSDKError(
            "input_too_large",
            `SDK Turn input 超过 ${MAX_INPUT_CHARACTERS} 字符上限`
        );
    }
    return input;
}

function validateTurnOptions(options: TurnOptions): void {
    if (
        options.permissionMode !== undefined &&
        !isPermissionMode(options.permissionMode)
    ) {
        throw new PillarSDKError(
            "invalid_permission_mode",
            `无效 permissionMode: ${String(options.permissionMode)}`
        );
    }
    if (
        options.collaborationMode !== undefined &&
        !isCollaborationMode(options.collaborationMode)
    ) {
        throw new PillarSDKError(
            "invalid_collaboration_mode",
            `无效 collaborationMode: ${String(options.collaborationMode)}`
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
            `maxIterations 必须是 1-${MAX_SDK_ITERATIONS} 的整数`
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
            message: `Turn 已取消: ${normalizeTurnAbortReason(signal.reason)}`,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {code: "runtime_error", message: message.slice(0, 1_000)};
}

async function reportHookIssues(
    host: PillarHost | undefined,
    result: Parameters<typeof getHookExecutionIssues>[0]
): Promise<void> {
    for (const issue of getHookExecutionIssues(result)) {
        try {
            await host?.onDiagnostic?.({
                severity: "warning",
                scope: "hook",
                message: issue,
            });
        } catch {
            // Host diagnostic sink 不能破坏 Session 生命周期。
        }
    }
}
