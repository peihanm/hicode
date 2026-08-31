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
import type {LLMCallOptions, LLMCallResult, TokenUsage} from "../../types.js";
import {
    throwIfTurnAborted,
    TurnInterruptedError,
    normalizeTurnAbortReason,
} from "../../../runtime/abort.js";
import {
    agentMessageDeltaSchema,
    CODEX_BRIDGE_OUTPUT_SCHEMA,
    codexBridgeDeveloperInstructions,
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
    outputCharacters: number;
    onProgress?: LLMCallOptions["onStreamProgress"];
    signal?: AbortSignal;
    violation?: string;
    resolve(): void;
    reject(error: Error): void;
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

class CodexAppServerRuntime implements CodexAppServerRuntimeLike {
    private child?: ChildProcessWithoutNullStreams;
    private isolatedHome?: string;
    private startPromise?: Promise<void>;
    private closePromise?: Promise<void>;
    private nextRequestId = 1;
    private readonly pending = new Map<RequestId, PendingRequest>();
    private active?: ActiveCall;
    private stderr = "";
    private closed = false;

    constructor(
        private readonly environment: ChildProcessEnvironment,
        private readonly executable: string,
        private readonly dependencies: CodexAppServerDependencies
    ) {}

    async call(options: LLMCallOptions): Promise<LLMCallResult> {
        if (this.active) throw new Error("Codex App Server 同时只允许一个模型调用");
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
    }

    close(): Promise<void> {
        this.closePromise ??= this.closeImpl();
        return this.closePromise;
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
                developerInstructions: codexBridgeDeveloperInstructions(),
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
            outputCharacters: 0,
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
                        text: createCodexBridgePrompt(options.messages, options.tools),
                    }],
                    cwd: callDirectory,
                    approvalPolicy: "never",
                    permissions: PILLAR_PERMISSION_PROFILE,
                    model: options.model,
                    effort: "high",
                    summary: "concise",
                    outputSchema: CODEX_BRIDGE_OUTPUT_SCHEMA,
                }
            ));
            active.turnId = turnResult.turn.id;
            if (active.violation) abort();
            if (options.signal?.aborted) abort();
            await completion.promise;
            if (active.violation) throw new Error(active.violation);
            if (options.signal?.aborted) {
                throw new TurnInterruptedError(
                    normalizeTurnAbortReason(options.signal.reason)
                );
            }
            const text = active.finalMessages.at(-1);
            if (!text) throw new Error("Codex App Server 没有返回最终 Agent Message");
            const parsed = parseCodexBridgeResponse(text);
            return {
                message: {
                    role: "assistant",
                    content: parsed.content,
                    ...(parsed.toolCalls.length > 0
                        ? {tool_calls: parsed.toolCalls}
                        : {}),
                },
                toolCalls: parsed.toolCalls,
                usage: active.usage ?? {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                },
            };
        } finally {
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
                if (text !== undefined) active.finalMessages.push(text);
            }
            return;
        }
        if (method === "rawResponse/completed") {
            const parsed = rawResponseCompletedSchema.safeParse(params);
            if (!parsed.success || parsed.data.threadId !== active.threadId) return;
            if (active.turnId && parsed.data.turnId !== active.turnId) return;
            if (parsed.data.usage) {
                active.usage = {
                    prompt_tokens: parsed.data.usage.inputTokens,
                    completion_tokens: parsed.data.usage.outputTokens,
                    total_tokens: parsed.data.usage.totalTokens,
                };
            }
            return;
        }
        if (method === "thread/tokenUsage/updated") {
            const parsed = threadTokenUsageUpdatedSchema.safeParse(params);
            if (!parsed.success || parsed.data.threadId !== active.threadId) return;
            if (active.turnId && parsed.data.turnId !== active.turnId) return;
            const usage = parsed.data.tokenUsage.total;
            active.usage = {
                prompt_tokens: usage.inputTokens,
                completion_tokens: usage.outputTokens,
                total_tokens: usage.totalTokens,
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
                (active.violation || active.signal?.aborted)
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
