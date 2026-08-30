// LSP Client：spawn LSP server 子进程 + JSON-RPC over stdio 通信
//
// 这里不用 vscode-jsonrpc 的 StreamMessageReader/Writer。当前 CLI 跑在 Bun 下，
// Node stream 兼容层会导致 language server initialize 卡住；手写 LSP frame
// parser/writer 更小，也更容易控制超时和 server->client request。

import {type ChildProcess, spawn} from "child_process";
import type {InitializeParams, InitializeResult} from "vscode-languageserver-protocol";
import {normalizeTurnAbortReason, TurnInterruptedError,} from "../runtime/abort.js";
import {
    mergeChildProcessEnvironment,
    type ChildProcessEnvironment,
} from "../runtime/childEnvironment.js";

const LSP_REQUEST_TIMEOUT_MS = 10_000;
const LSP_SHUTDOWN_TIMEOUT_MS = 2_000;
const LSP_EXIT_GRACE_MS = 250;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_MESSAGE_BYTES;

type JsonRpcId = number | string;

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: JsonRpcId;
    method: string;
    params?: unknown;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
    cleanupAbort?: () => void;
}

type NotificationHandler<T> = (params: T) => void;

async function waitForProcessExit(
    child: ChildProcess,
    timeoutMs: number
): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.removeListener("exit", finish);
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        child.once("exit", finish);
    });
}

export interface LSPClient {
    start(command: string, args: string[], options: {
        cwd: string;
        environment: ChildProcessEnvironment;
    }): Promise<void>;

    initialize(params: InitializeParams, signal?: AbortSignal): Promise<InitializeResult>;

    sendRequest<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;

    sendNotification(method: string, params: unknown): Promise<void>;

    onNotification<T>(method: string, handler: (params: T) => void): void;

    stop(): Promise<void>;

    readonly isInitialized: boolean;
}

export function createLSPClient(
    serverName: string,
    onCrash?: (error: Error) => void
): LSPClient {
    let proc: ChildProcess | undefined;
    let initialized = false;
    let stopping = false;
    let nextId = 1;
    let inputBuffer = Buffer.alloc(0);
    const pending = new Map<JsonRpcId, PendingRequest>();
    const notificationHandlers = new Map<string, NotificationHandler<unknown>[]>();

    function protocolFailure(message: string): void {
        const error = new Error(`LSP server ${serverName} protocol error: ${message}`);
        inputBuffer = Buffer.alloc(0);
        rejectAllPending(error);
        try {
            proc?.kill();
        } catch {
            // 进程可能已经退出。
        }
    }

    function rejectAllPending(err: Error): void {
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.cleanupAbort?.();
            request.reject(err);
        }
        pending.clear();
    }

    function writeMessage(message: unknown): void {
        if (!proc?.stdin || proc.stdin.destroyed) {
            throw new Error(`LSP server ${serverName} stdin 不可用`);
        }
        const body = JSON.stringify(message);
        const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
        proc.stdin.write(header + body, "utf8");
    }

    function sendResponse(id: JsonRpcId, result: unknown): void {
        writeMessage({jsonrpc: "2.0", id, result});
    }

    function handleServerRequest(message: JsonRpcRequest): void {
        if (message.id === undefined) {
            const handlers = notificationHandlers.get(message.method) ?? [];
            for (const handler of handlers) {
                handler(message.params);
            }
            return;
        }

        // Minimal client-side request support. Some servers ask the client for
        // workspace/configuration during initialize; returning [] is accepted by
        // typescript-language-server and pyright for our simplified use case.
        const result = message.method === "workspace/configuration" ? [] : null;
        sendResponse(message.id, result);
    }

    function handleMessage(message: unknown): void {
        if (
            !message ||
            typeof message !== "object" ||
            Array.isArray(message) ||
            (message as {jsonrpc?: unknown}).jsonrpc !== "2.0"
        ) {
            throw new Error("invalid JSON-RPC envelope");
        }
        const record = message as Record<string, unknown>;
        if ("method" in record) {
            if (typeof record.method !== "string" || record.method.length > 1024) {
                throw new Error("invalid JSON-RPC method");
            }
            if (
                record.id !== undefined &&
                typeof record.id !== "string" &&
                typeof record.id !== "number"
            ) throw new Error("invalid JSON-RPC request id");
            handleServerRequest({
                jsonrpc: "2.0",
                method: record.method,
                ...(record.id !== undefined ? {id: record.id} : {}),
                ...(record.params !== undefined ? {params: record.params} : {}),
            });
            return;
        }

        if (
            typeof record.id !== "string" &&
            typeof record.id !== "number"
        ) throw new Error("invalid JSON-RPC response id");
        const responseId = record.id;
        const request = pending.get(responseId);
        if (!request) return;
        let responseError:
            | {code: number; message: string; data?: unknown}
            | undefined;
        if (record.error !== undefined) {
            if (
                !record.error ||
                typeof record.error !== "object" ||
                Array.isArray(record.error)
            ) throw new Error("invalid JSON-RPC error response");
            const rawError = record.error as Record<string, unknown>;
            if (
                typeof rawError.code !== "number" ||
                typeof rawError.message !== "string"
            ) throw new Error("invalid JSON-RPC error response");
            responseError = {
                code: rawError.code,
                message: rawError.message,
                ...(rawError.data !== undefined ? {data: rawError.data} : {}),
            };
        }
        pending.delete(responseId);
        clearTimeout(request.timer);
        request.cleanupAbort?.();
        if (responseError) {
            const err = new Error(responseError.message.slice(0, 16_384));
            (err as Error & { code?: number; data?: unknown }).code =
                responseError.code;
            (err as Error & { code?: number; data?: unknown }).data =
                responseError.data;
            request.reject(err);
            return;
        }
        request.resolve(record.result);
    }

    function parseMessages(): void {
        while (true) {
            const headerEnd = inputBuffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
                if (inputBuffer.length > MAX_HEADER_BYTES) {
                    protocolFailure("header exceeds limit");
                }
                return;
            }
            if (headerEnd > MAX_HEADER_BYTES) {
                protocolFailure("header exceeds limit");
                return;
            }

            const header = inputBuffer.slice(0, headerEnd).toString("ascii");
            const lengths = header
                .split("\r\n")
                .filter((line) => /^Content-Length:/i.test(line))
                .map((line) => line.slice(line.indexOf(":") + 1).trim());
            if (lengths.length !== 1 || !/^\d+$/.test(lengths[0]!)) {
                protocolFailure("invalid Content-Length header");
                return;
            }

            const length = Number(lengths[0]);
            if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES) {
                protocolFailure("Content-Length exceeds limit");
                return;
            }
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + length;
            if (inputBuffer.length < bodyEnd) return;

            const body = inputBuffer.slice(bodyStart, bodyEnd).toString("utf8");
            inputBuffer = inputBuffer.slice(bodyEnd);

            try {
                handleMessage(JSON.parse(body));
            } catch (error) {
                protocolFailure(
                    error instanceof Error ? error.message : String(error)
                );
                return;
            }
        }
    }

    function request<T>(
        method: string,
        params: unknown,
        timeoutMs: number,
        signal?: AbortSignal
    ): Promise<T> {
        const id = nextId++;
        return new Promise<T>((resolve, reject) => {
            if (signal?.aborted) {
                reject(new TurnInterruptedError(normalizeTurnAbortReason(signal.reason)));
                return;
            }
            let settled = false;
            const settleReject = (error: Error) => {
                if (settled) return;
                settled = true;
                reject(error);
            };
            const timer = setTimeout(() => {
                pending.delete(id);
                cleanupAbort();
                settleReject(new Error(`LSP server ${serverName} request ${method} timed out`));
            }, timeoutMs);
            const onAbort = () => {
                const request = pending.get(id);
                if (!request) return;
                pending.delete(id);
                clearTimeout(timer);
                cleanupAbort();
                try {
                    writeMessage({
                        jsonrpc: "2.0",
                        method: "$/cancelRequest",
                        params: {id},
                    });
                } catch {
                }
                settleReject(
                    new TurnInterruptedError(normalizeTurnAbortReason(signal?.reason))
                );
            };
            const cleanupAbort = () => signal?.removeEventListener("abort", onAbort);
            signal?.addEventListener("abort", onAbort, {once: true});
            pending.set(id, {
                resolve: (value) => {
                    if (settled) return;
                    settled = true;
                    resolve(value as T);
                },
                reject: settleReject,
                timer,
                cleanupAbort,
            });

            try {
                writeMessage({jsonrpc: "2.0", id, method, params});
            } catch (err) {
                clearTimeout(timer);
                pending.delete(id);
                cleanupAbort();
                settleReject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    return {
        get isInitialized() {
            return initialized;
        },

        async start(command, args, options) {
            proc = spawn(command, args, {
                stdio: ["pipe", "pipe", "pipe"],
                cwd: options.cwd,
                env: mergeChildProcessEnvironment(options.environment),
                windowsHide: true,
            });

            if (!proc.stdout || !proc.stdin) {
                throw new Error(`LSP server ${serverName}: stdio 不可用`);
            }

            proc.stdout.on("data", (chunk: Buffer) => {
                if (inputBuffer.length + chunk.length > MAX_INPUT_BUFFER_BYTES) {
                    protocolFailure("input buffer exceeds limit");
                    return;
                }
                inputBuffer = Buffer.concat([inputBuffer, chunk]);
                parseMessages();
            });

            // 始终消费 stderr，但不直接写终端，避免污染 Ink 输出或泄漏 Server 数据。
            proc.stderr?.on("data", () => undefined);

            proc.on("exit", (code) => {
                initialized = false;
                rejectAllPending(
                    new Error(`LSP server ${serverName} exited (${code ?? "unknown"})`)
                );
                if (code !== 0 && code !== null && !stopping) {
                    onCrash?.(new Error(`LSP server ${serverName} crashed (exit ${code})`));
                }
            });

            proc.on("error", (err) => {
                initialized = false;
                rejectAllPending(err);
                if (!stopping) {
                    onCrash?.(err);
                }
            });
        },

        async initialize(params, signal) {
            const result = await request<InitializeResult>(
                "initialize",
                params,
                LSP_REQUEST_TIMEOUT_MS,
                signal
            );
            await this.sendNotification("initialized", {});
            initialized = true;
            return result;
        },

        async sendRequest<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
            if (!initialized) throw new Error(`LSP server ${serverName} 未初始化`);
            return request<T>(method, params, LSP_REQUEST_TIMEOUT_MS, signal);
        },

        async sendNotification(method: string, params: unknown): Promise<void> {
            writeMessage({jsonrpc: "2.0", method, params});
        },

        onNotification<T>(method: string, handler: (params: T) => void): void {
            const handlers = notificationHandlers.get(method) ?? [];
            handlers.push(handler as NotificationHandler<unknown>);
            notificationHandlers.set(method, handlers);
        },

        async stop() {
            stopping = true;
            const child = proc;
            try {
                if (child && initialized) {
                    await request("shutdown", {}, LSP_SHUTDOWN_TIMEOUT_MS).catch(() => {
                    });
                    await this.sendNotification("exit", {});
                    await waitForProcessExit(child, LSP_EXIT_GRACE_MS);
                }
            } finally {
                rejectAllPending(new Error(`LSP server ${serverName} stopped`));
                try {
                    if (
                        child &&
                        child.exitCode === null &&
                        child.signalCode === null
                    ) {
                        child.kill();
                    }
                } catch {
                }
                child?.removeAllListeners();
                proc = undefined;
                initialized = false;
                stopping = false;
                inputBuffer = Buffer.alloc(0);
            }
        },
    };
}
