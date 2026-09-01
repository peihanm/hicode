import {
    spawn,
    type ChildProcessWithoutNullStreams,
    type SpawnOptions,
} from "node:child_process";
import {createInterface} from "node:readline";
import {homedir, tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {lstat, mkdtemp, rm, symlink, writeFile} from "node:fs/promises";
import type {ChildProcessEnvironment} from "../../../runtime/childEnvironment.js";
import {mergeChildProcessEnvironment} from "../../../runtime/childEnvironment.js";
import {createProcessTreeKiller} from "../../../tools/bash/process.js";
import type {
    LLMCallOptions,
    LLMCallResult,
    LLMContextUsage,
    TokenUsage,
} from "../../types.js";
import {
    throwIfTurnAborted,
    TurnInterruptedError,
    normalizeTurnAbortReason,
} from "../../../runtime/abort.js";
import {
    agentMessageDeltaSchema,
    CodexBridgeResponseError,
    type CodexBridgeRepairReason,
    codexBridgeInstructions,
    createCodexBridgeOutputSchema,
    createCodexBridgePrompt,
    itemNotificationSchema,
    jsonRpcMessageSchema,
    parseCodexBridgeResponse,
    permissionProfileListResultSchema,
    rawResponseCompletedSchema,
    reasoningDeltaSchema,
    threadStartResultSchema,
    threadTokenUsageUpdatedSchema,
    turnCompletedSchema,
    turnStartResultSchema,
    type JsonRpcMessage,
} from "./protocol.js";

const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;
const START_TIMEOUT_MS = 30_000;
const CODEX_OUTPUT_STALL_TIMEOUT_MS = 60_000;
const CODEX_MAX_OUTPUT_STALL_RETRIES = 2;
const PILLAR_PERMISSION_PROFILE = "pillar_model";
const PILLAR_CODEX_CONFIG = `default_permissions = "${PILLAR_PERMISSION_PROFILE}"

[permissions.${PILLAR_PERMISSION_PROFILE}]
description = "Pillar model bridge: isolated read-only workspace"

[permissions.${PILLAR_PERMISSION_PROFILE}.filesystem]
":minimal" = "read"
":workspace_roots" = "read"
`;
const FORBIDDEN_ITEM_TYPES = new Set([
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "subAgentActivity",
    "webSearch",
    "imageGeneration",
    "imageView",
]);

type RequestId = number;

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

interface ActiveCall {
    threadId: string;
    turnId?: string;
    finalMessages: string[];
    usage?: TokenUsage;
    contextUsage?: LLMContextUsage;
    receivedThreadUsage: boolean;
    outputCharacters: number;
    outputStallWarningTimer?: ReturnType<typeof setTimeout>;
    outputStallTimer?: ReturnType<typeof setTimeout>;
    stallInterrupt?: Promise<void>;
    stalled: boolean;
    onProgress?: LLMCallOptions["onStreamProgress"];
    signal?: AbortSignal;
    violation?: string;
    resolve(): void;
    reject(error: Error): void;
}

interface CompletedCodexTurn {
    text: string;
    usage: TokenUsage;
    contextUsage?: LLMContextUsage;
    violation?: string;
    stalled?: boolean;
}

export interface CodexAppServerRuntimeLike {
    call(options: LLMCallOptions): Promise<LLMCallResult>;
    close(): Promise<void>;
}

interface CodexAppServerDependencies {
    spawnProcess(
        command: string,
        args: readonly string[],
        options: SpawnOptions
    ): ChildProcessWithoutNullStreams;
    createTemporaryDirectory(prefix: string): Promise<string>;
    removeDirectory(path: string): Promise<void>;
    linkAuthentication(source: string, target: string): Promise<void>;
    authFileExists(path: string): Promise<boolean>;
    killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void>;
    outputStallTimeoutMs: number;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function boundedStderr(current: string, chunk: Buffer | string): string {
    const next = current + chunk.toString();
    return next.length <= MAX_STDERR_CHARS
        ? next
        : next.slice(next.length - MAX_STDERR_CHARS);
}

function rpcError(message: JsonRpcMessage): Error {
    const detail = message.error?.message ?? "Codex app-server request failed";
    return new Error(`Codex App Server 错误：${detail}`);
}

function parseAgentMessage(item: Record<string, unknown>): string | undefined {
    if (item.type !== "agentMessage" || typeof item.text !== "string") {
        return undefined;
    }
    const phase = item.phase;
    return phase === undefined || phase === null || phase === "final_answer"
        ? item.text
        : undefined;
}

function emptyUsage(): TokenUsage {
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
    };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
    return {
        prompt_tokens: left.prompt_tokens + right.prompt_tokens,
        completion_tokens: left.completion_tokens + right.completion_tokens,
        total_tokens: left.total_tokens + right.total_tokens,
    };
}

class CodexAppServerRuntime implements CodexAppServerRuntimeLike {
    private child?: ChildProcessWithoutNullStreams;
    private isolatedHome?: string;
    private startPromise?: Promise<void>;
    private closePromise?: Promise<void>;
    private nextRequestId = 1;
    private readonly pending = new Map<RequestId, PendingRequest>();
    private active?: ActiveCall;
    private callQueue: Promise<void> = Promise.resolve();
    private stderr = "";
    private closed = false;

    constructor(
        private readonly environment: ChildProcessEnvironment,
        private readonly executable: string,
        private readonly dependencies: CodexAppServerDependencies
    ) {}

    async call(options: LLMCallOptions): Promise<LLMCallResult> {
        const previous = this.callQueue;
        const gate = Promise.withResolvers<void>();
        this.callQueue = previous.then(() => gate.promise);
        try {
            await this.waitForCallSlot(previous, options.signal);
            if (options.signal) throwIfTurnAborted(options.signal);
            await this.ensureStarted();
            if (options.signal) throwIfTurnAborted(options.signal);
            const callDirectory = await this.dependencies.createTemporaryDirectory(
                join(tmpdir(), "pillar-codex-call-")
            );
            try {
                return await this.runIsolatedCall(options, callDirectory);
            } finally {
                await this.dependencies.removeDirectory(callDirectory).catch(() => undefined);
            }
        } finally {
            gate.resolve();
        }
    }

    close(): Promise<void> {
        this.closePromise ??= this.closeImpl();
        return this.closePromise;
    }

    private waitForCallSlot(
        previous: Promise<void>,
        signal?: AbortSignal
    ): Promise<void> {
        if (!signal) return previous;
        throwIfTurnAborted(signal);
        return new Promise<void>((resolveWait, rejectWait) => {
            let settled = false;
            const finish = (callback: () => void) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener("abort", onAbort);
                callback();
            };
            const onAbort = () => finish(() => rejectWait(
                new TurnInterruptedError(normalizeTurnAbortReason(signal.reason))
            ));
            signal.addEventListener("abort", onAbort, {once: true});
            void previous.then(
                () => finish(resolveWait),
                (error: unknown) => finish(() => rejectWait(error))
            );
        });
    }

    private clearOutputStallWatchdog(active: ActiveCall): void {
        if (active.outputStallWarningTimer !== undefined) {
            clearTimeout(active.outputStallWarningTimer);
            active.outputStallWarningTimer = undefined;
        }
        if (active.outputStallTimer !== undefined) {
            clearTimeout(active.outputStallTimer);
            active.outputStallTimer = undefined;
        }
    }

    private resetOutputStallWatchdog(active: ActiveCall): void {
        this.clearOutputStallWatchdog(active);
        if (!active.turnId || active.stalled) return;
        const timeoutMs = this.dependencies.outputStallTimeoutMs;
        const warningMs = Math.max(1, Math.floor(timeoutMs / 2));
        active.outputStallWarningTimer = setTimeout(() => {
            active.onProgress?.({
                phase: "stalled",
                outputCharacters: active.outputCharacters,
                estimatedOutputTokens: Math.ceil(active.outputCharacters / 4),
                idleMilliseconds: warningMs,
            });
        }, warningMs);
        active.outputStallWarningTimer.unref?.();
        active.outputStallTimer = setTimeout(() => {
            if (!active.turnId || active.stalled) return;
            active.stalled = true;
            this.clearOutputStallWatchdog(active);
            active.stallInterrupt = this.request("turn/interrupt", {
                threadId: active.threadId,
                turnId: active.turnId,
            }).then(() => undefined);
            active.resolve();
        }, timeoutMs);
        active.outputStallTimer.unref?.();
    }

    private async ensureStarted(): Promise<void> {
        if (this.closed) throw new Error("Codex App Server Runtime 已关闭");
        this.startPromise ??= this.start();
        return this.startPromise;
    }

    private async start(): Promise<void> {
        const isolatedHome = await this.dependencies.createTemporaryDirectory(
            join(tmpdir(), "pillar-codex-home-")
        );
        this.isolatedHome = isolatedHome;
        const configuredHome = process.env.CODEX_HOME?.trim();
        const authSource = join(
            configuredHome ? resolve(configuredHome) : join(homedir(), ".codex"),
            "auth.json"
        );
        if (await this.dependencies.authFileExists(authSource)) {
            await this.dependencies.linkAuthentication(
                authSource,
                join(isolatedHome, "auth.json")
            );
        }
        await writeFile(
            join(isolatedHome, "config.toml"),
            PILLAR_CODEX_CONFIG,
            {encoding: "utf8", mode: 0o600}
        );

        let child: ChildProcessWithoutNullStreams;
        try {
            child = this.dependencies.spawnProcess(
                this.executable,
                ["app-server"],
                {
                    cwd: isolatedHome,
                    shell: false,
                    detached: process.platform !== "win32",
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                    env: mergeChildProcessEnvironment(this.environment, {
                        CODEX_HOME: isolatedHome,
                        RUST_LOG: "error",
                    }),
                }
            ) as ChildProcessWithoutNullStreams;
        } catch (error) {
            throw new Error(`无法启动 Codex App Server：${errorMessage(error)}`);
        }
        this.child = child;
        child.stderr.on("data", (chunk) => {
            this.stderr = boundedStderr(this.stderr, chunk);
        });
        child.once("error", (error) => this.failAll(
            new Error(`Codex App Server 进程错误：${error.message}`)
        ));
        child.once("close", (code, signal) => this.failAll(new Error(
            `Codex App Server 已退出（${signal ? `signal ${signal}` : `exit ${code ?? 1}`}）${
                this.stderr.trim() ? `：${this.stderr.trim()}` : ""
            }`
        )));

        const lines = createInterface({input: child.stdout, crlfDelay: Infinity});
        lines.on("line", (line) => this.handleLine(line));
        await this.request("initialize", {
            clientInfo: {
                name: "pillar",
                title: "Pillar",
                version: "0.1.0",
            },
            capabilities: {
                experimentalApi: true,
                requestAttestation: false,
            },
        });
        this.notify("initialized", {});
    }

    private async runIsolatedCall(
        options: LLMCallOptions,
        callDirectory: string
    ): Promise<LLMCallResult> {
        let usage = emptyUsage();
        let contextUsage: LLMContextUsage | undefined;
        let repair: CodexBridgeRepairReason | undefined;
        let bridgeRepairUsed = false;
        let outputStallRetries = 0;
        const maxAttempts = CODEX_MAX_OUTPUT_STALL_RETRIES + 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const completed = await this.runSingleIsolatedTurn(
                options,
                callDirectory,
                repair
            );
            usage = addUsage(usage, completed.usage);
            contextUsage = completed.contextUsage;
            if (completed.stalled) {
                if (
                    outputStallRetries >= CODEX_MAX_OUTPUT_STALL_RETRIES ||
                    attempt >= maxAttempts
                ) {
                    throw new Error(
                        `Codex 输出连续 ${this.dependencies.outputStallTimeoutMs}ms 没有新增量，安全重试后仍无进展`
                    );
                }
                outputStallRetries += 1;
                repair = "output_stall";
                options.onStreamProgress?.({
                    phase: "retrying",
                    outputCharacters: 0,
                    estimatedOutputTokens: 0,
                });
                continue;
            }
            if (completed.violation) {
                if (bridgeRepairUsed || attempt >= maxAttempts) {
                    throw new Error(
                        `Codex Bridge 修复重试失败：${completed.violation}`
                    );
                }
                bridgeRepairUsed = true;
                repair = "forbidden_builtin_tool";
                options.onStreamProgress?.({
                    phase: "retrying",
                    outputCharacters: 0,
                    estimatedOutputTokens: 0,
                });
                continue;
            }
            try {
                const parsed = parseCodexBridgeResponse(
                    completed.text,
                    options.tools
                );
                return {
                    message: {
                        role: "assistant",
                        content: parsed.content,
                        ...(parsed.toolCalls.length > 0
                            ? {tool_calls: parsed.toolCalls}
                            : {}),
                    },
                    toolCalls: parsed.toolCalls,
                    usage,
                    ...(contextUsage ? {contextUsage} : {}),
                };
            } catch (error) {
                if (!(error instanceof CodexBridgeResponseError)) throw error;
                if (bridgeRepairUsed || attempt >= maxAttempts) {
                    throw new CodexBridgeResponseError(
                        `Codex Bridge 修复重试失败：${error.message}`
                    );
                }
                bridgeRepairUsed = true;
                options.onStreamProgress?.({
                    phase: "retrying",
                    outputCharacters: 0,
                    estimatedOutputTokens: 0,
                });
                repair = "invalid_response";
            }
        }
        throw new Error("Codex 重试状态异常");
    }

    private async runSingleIsolatedTurn(
        options: LLMCallOptions,
        callDirectory: string,
        repair?: CodexBridgeRepairReason
    ): Promise<CompletedCodexTurn> {
        if (options.signal) throwIfTurnAborted(options.signal);
        const profiles = permissionProfileListResultSchema.parse(await this.request(
            "permissionProfile/list",
            {cwd: callDirectory, limit: 256}
        ));
        if (options.signal) throwIfTurnAborted(options.signal);
        const profile = profiles.data.find(
            (candidate) => candidate.id === PILLAR_PERMISSION_PROFILE
        );
        if (!profile?.allowed) {
            throw new Error(
                `Codex App Server 未启用 Pillar 的受限权限 Profile：${PILLAR_PERMISSION_PROFILE}`
            );
        }
        const threadResult = threadStartResultSchema.parse(await this.request(
            "thread/start",
            {
                model: options.model,
                cwd: callDirectory,
                approvalPolicy: "never",
                permissions: PILLAR_PERMISSION_PROFILE,
                ephemeral: true,
                serviceName: "pillar",
                baseInstructions: codexBridgeInstructions(),
                developerInstructions: codexBridgeInstructions(),
                config: {
                    mcp_servers: {},
                    plugins: {},
                },
            }
        ));
        if (options.signal) throwIfTurnAborted(options.signal);
        if (threadResult.thread.ephemeral !== true) {
            throw new Error("Codex App Server 未创建 ephemeral thread，已拒绝继续");
        }
        if (threadResult.activePermissionProfile.id !== PILLAR_PERMISSION_PROFILE) {
            throw new Error(
                `Codex App Server 未激活 Pillar 的受限权限 Profile：${threadResult.activePermissionProfile.id}`
            );
        }
        const completion = Promise.withResolvers<void>();
        const active: ActiveCall = {
            threadId: threadResult.thread.id,
            finalMessages: [],
            receivedThreadUsage: false,
            outputCharacters: 0,
            stalled: false,
            onProgress: options.onStreamProgress,
            signal: options.signal,
            resolve: completion.resolve,
            reject: completion.reject,
        };
        this.active = active;
        const abort = () => {
            if (!active.turnId) return;
            void this.request("turn/interrupt", {
                threadId: active.threadId,
                turnId: active.turnId,
            }).catch(() => undefined);
        };
        options.signal?.addEventListener("abort", abort, {once: true});
        try {
            const turnResult = turnStartResultSchema.parse(await this.request(
                "turn/start",
                {
                    threadId: active.threadId,
                    input: [{
                        type: "text",
                        text: createCodexBridgePrompt(
                            options.messages,
                            options.tools,
                            repair
                        ),
                    }],
                    cwd: callDirectory,
                    approvalPolicy: "never",
                    permissions: PILLAR_PERMISSION_PROFILE,
                    model: options.model,
                    effort: "high",
                    summary: "concise",
                    outputSchema: createCodexBridgeOutputSchema(options.tools),
                }
            ));
            active.turnId = turnResult.turn.id;
            if (active.violation || options.signal?.aborted) abort();
            else this.resetOutputStallWatchdog(active);
            await completion.promise;
            if (active.stalled) await active.stallInterrupt;
            if (options.signal?.aborted) {
                throw new TurnInterruptedError(
                    normalizeTurnAbortReason(options.signal.reason)
                );
            }
            const text = active.finalMessages.at(-1);
            if (!text && !active.violation && !active.stalled) {
                throw new Error("Codex App Server 没有返回最终 Agent Message");
            }
            return {
                text: text ?? "",
                usage: active.usage ?? emptyUsage(),
                ...(active.contextUsage
                    ? {contextUsage: active.contextUsage}
                    : {}),
                ...(active.violation ? {violation: active.violation} : {}),
                ...(active.stalled ? {stalled: true} : {}),
            };
        } finally {
            this.clearOutputStallWatchdog(active);
            options.signal?.removeEventListener("abort", abort);
            if (this.active === active) this.active = undefined;
        }
    }

    private handleLine(line: string): void {
        if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
            this.failAll(new Error("Codex App Server 单条协议消息超过 16 MiB"));
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch (error) {
            this.failAll(new Error(`Codex App Server 返回非法 JSON：${errorMessage(error)}`));
            return;
        }
        const parsed = jsonRpcMessageSchema.safeParse(value);
        if (!parsed.success) {
            this.failAll(new Error(`Codex App Server 返回非法协议消息：${parsed.error.message}`));
            return;
        }
        const message = parsed.data;
        if (typeof message.id === "number" && message.method === undefined) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(rpcError(message));
            else pending.resolve(message.result);
            return;
        }
        if (message.method && message.id !== undefined) {
            this.handleServerRequest(message);
            return;
        }
        if (message.method) this.handleNotification(message.method, message.params);
    }

    private handleServerRequest(message: JsonRpcMessage): void {
        // This provider is deliberately a model-only bridge. Any server request
        // means Codex tried to cross into its own tool/control plane.
        const active = this.active;
        if (active) {
            active.violation = `Codex 尝试调用被禁用的内置能力：${message.method}`;
            if (active.turnId) {
                void this.request("turn/interrupt", {
                    threadId: active.threadId,
                    turnId: active.turnId,
                }).catch(() => undefined);
            }
        }
        this.write({
            id: message.id,
            error: {
                code: -32001,
                message: "Pillar model bridge disables Codex built-in tools",
            },
        });
    }

    private handleNotification(method: string, params: unknown): void {
        const active = this.active;
        if (!active) return;
        if (method === "item/agentMessage/delta") {
            const parsed = agentMessageDeltaSchema.safeParse(params);
            if (!parsed.success || parsed.data.threadId !== active.threadId) return;
            if (active.turnId && parsed.data.turnId !== active.turnId) return;
            active.outputCharacters += parsed.data.delta.length;
            this.resetOutputStallWatchdog(active);
            active.onProgress?.({
                phase: "content",
                outputCharacters: active.outputCharacters,
                estimatedOutputTokens: Math.ceil(active.outputCharacters / 4),
            });
            return;
        }
        if (
            method === "item/reasoning/summaryTextDelta" ||
            method === "item/reasoning/textDelta"
        ) {
            const parsed = reasoningDeltaSchema.safeParse(params);
            if (!parsed.success || parsed.data.threadId !== active.threadId) return;
            if (active.turnId && parsed.data.turnId !== active.turnId) return;
            active.outputCharacters += parsed.data.delta.length;
            this.resetOutputStallWatchdog(active);
            active.onProgress?.({
                phase: "reasoning",
                outputCharacters: active.outputCharacters,
                estimatedOutputTokens: Math.ceil(active.outputCharacters / 4),
            });
            return;
        }
        if (method === "item/started" || method === "item/completed") {
            const parsed = itemNotificationSchema.safeParse(params);
            if (!parsed.success || parsed.data.threadId !== active.threadId) return;
            if (active.turnId && parsed.data.turnId !== active.turnId) return;
            const item = parsed.data.item;
            if (FORBIDDEN_ITEM_TYPES.has(item.type)) {
                active.violation = `Codex 尝试调用被禁用的内置能力：${item.type}`;
                if (active.turnId) {
                    void this.request("turn/interrupt", {
                        threadId: active.threadId,
                        turnId: active.turnId,
                    }).catch(() => undefined);
                }
                return;
            }
            if (method === "item/completed") {
                const text = parseAgentMessage(item);
                if (text !== undefined) {
                    active.finalMessages.push(text);
                    this.resetOutputStallWatchdog(active);
                }
            }
            return;
        }
        if (method === "rawResponse/completed") {
            const parsed = rawResponseCompletedSchema.safeParse(params);
            if (!parsed.success || parsed.data.threadId !== active.threadId) return;
            if (active.turnId && parsed.data.turnId !== active.turnId) return;
            if (parsed.data.usage && !active.receivedThreadUsage) {
                active.usage = {
                    prompt_tokens: parsed.data.usage.inputTokens,
                    completion_tokens: parsed.data.usage.outputTokens,
                    total_tokens: parsed.data.usage.totalTokens,
                };
                active.contextUsage = {
                    tokenCount: parsed.data.usage.totalTokens,
                };
            }
            return;
        }
        if (method === "thread/tokenUsage/updated") {
            const parsed = threadTokenUsageUpdatedSchema.safeParse(params);
            if (!parsed.success || parsed.data.threadId !== active.threadId) return;
            if (active.turnId && parsed.data.turnId !== active.turnId) return;
            const usage = parsed.data.tokenUsage.total;
            const context = parsed.data.tokenUsage.last;
            active.receivedThreadUsage = true;
            active.usage = {
                prompt_tokens: usage.inputTokens,
                completion_tokens: usage.outputTokens,
                total_tokens: usage.totalTokens,
            };
            active.contextUsage = {
                tokenCount: context.totalTokens,
                ...(parsed.data.tokenUsage.modelContextWindow !== undefined &&
                    parsed.data.tokenUsage.modelContextWindow !== null
                    ? {contextWindow: parsed.data.tokenUsage.modelContextWindow}
                    : {}),
            };
            return;
        }
        if (method === "turn/completed") {
            const parsed = turnCompletedSchema.safeParse(params);
            if (!parsed.success || parsed.data.threadId !== active.threadId) return;
            if (active.turnId && parsed.data.turn.id !== active.turnId) return;
            active.turnId = parsed.data.turn.id;
            if (parsed.data.turn.status === "failed") {
                active.reject(new Error(
                    `Codex Turn 失败：${parsed.data.turn.error?.message ?? "未知错误"}`
                ));
            } else if (parsed.data.turn.status === "completed") {
                active.resolve();
            } else if (
                parsed.data.turn.status === "interrupted" &&
                (active.violation || active.stalled || active.signal?.aborted)
            ) {
                active.resolve();
            } else {
                active.reject(new Error(
                    `Codex Turn 未正常完成：${parsed.data.turn.status}`
                ));
            }
        }
    }

    private request(method: string, params: unknown): Promise<unknown> {
        const id = this.nextRequestId++;
        const promise = new Promise<unknown>((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                rejectRequest(new Error(`Codex App Server 请求超时：${method}`));
            }, START_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: resolveRequest,
                reject: rejectRequest,
                timer,
            });
        });
        this.write({method, id, params});
        return promise;
    }

    private notify(method: string, params: unknown): void {
        this.write({method, params});
    }

    private write(message: Record<string, unknown>): void {
        const child = this.child;
        if (!child || child.stdin.destroyed) {
            throw new Error("Codex App Server stdin 不可用");
        }
        child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    private failAll(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.active?.reject(error);
    }

    private async closeImpl(): Promise<void> {
        this.closed = true;
        const child = this.child;
        this.child = undefined;
        if (child && child.exitCode === null) {
            await this.dependencies.killProcessTree(child).catch(() => undefined);
        }
        this.failAll(new Error("Codex App Server Runtime 已关闭"));
        if (this.isolatedHome) {
            const home = this.isolatedHome;
            this.isolatedHome = undefined;
            await this.dependencies.removeDirectory(home).catch(() => undefined);
        }
    }
}

const killProcessTree = createProcessTreeKiller();

export function createCodexAppServerRuntimeFactory(
    overrides: Partial<CodexAppServerDependencies> = {}
) {
    const dependencies: CodexAppServerDependencies = {
        spawnProcess: overrides.spawnProcess ?? ((command, args, options) =>
            spawn(command, args, options) as ChildProcessWithoutNullStreams),
        createTemporaryDirectory: overrides.createTemporaryDirectory ?? mkdtemp,
        removeDirectory: overrides.removeDirectory ?? ((path) =>
            rm(path, {recursive: true, force: true})),
        linkAuthentication: overrides.linkAuthentication ?? ((source, target) =>
            symlink(source, target)),
        authFileExists: overrides.authFileExists ?? (async (path) => {
            try {
                const info = await lstat(path);
                return info.isFile() || info.isSymbolicLink();
            } catch (error) {
                if (
                    error && typeof error === "object" && "code" in error &&
                    (error as {code?: string}).code === "ENOENT"
                ) return false;
                throw error;
            }
        }),
        killProcessTree: overrides.killProcessTree ?? killProcessTree,
        outputStallTimeoutMs:
            overrides.outputStallTimeoutMs ?? CODEX_OUTPUT_STALL_TIMEOUT_MS,
    };
    return (
        environment: ChildProcessEnvironment,
        executable = "codex"
    ): CodexAppServerRuntimeLike => new CodexAppServerRuntime(
        environment,
        executable,
        dependencies
    );
}

export const createCodexAppServerRuntime = createCodexAppServerRuntimeFactory();
