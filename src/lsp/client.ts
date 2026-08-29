// LSP Client：spawn LSP server 子进程 + JSON-RPC over stdio 通信
//
// 这里不用 vscode-jsonrpc 的 StreamMessageReader/Writer。当前 CLI 跑在 Bun 下，
// Node stream 兼容层会导致 language server initialize 卡住；手写 LSP frame
// parser/writer 更小，也更容易控制超时和 server->client request。

import {type ChildProcess, spawn} from "child_process";
import type {InitializeParams, InitializeResult} from "vscode-languageserver-protocol";
import {normalizeTurnAbortReason, TurnInterruptedError,} from "../runtime/abort.js";

const LSP_REQUEST_TIMEOUT_MS = 10_000;
const LSP_SHUTDOWN_TIMEOUT_MS = 2_000;
const LSP_EXIT_GRACE_MS = 250;

type JsonRpcId = number | string;

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

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
    start(command: string, args: string[], options?: { cwd?: string }): Promise<void>;

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

    function handleMessage(message: JsonRpcResponse | JsonRpcRequest): void {
        if ("method" in message) {
            handleServerRequest(message);
            return;
        }

        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        request.cleanupAbort?.();

        if (message.error) {
            const err = new Error(message.error.message);
            (err as Error & { code?: number; data?: unknown }).code = message.error.code;
            (err as Error & { code?: number; data?: unknown }).data = message.error.data;
            request.reject(err);
            return;
        }
        request.resolve(message.result);
    }

    function parseMessages(): void {
        while (true) {
            const headerEnd = inputBuffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;

            const header = inputBuffer.slice(0, headerEnd).toString("ascii");
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                inputBuffer = inputBuffer.slice(headerEnd + 4);
                continue;
            }

            const length = Number(match[1]);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + length;
            if (inputBuffer.length < bodyEnd) return;

            const body = inputBuffer.slice(bodyStart, bodyEnd).toString("utf8");
            inputBuffer = inputBuffer.slice(bodyEnd);

            try {
                handleMessage(JSON.parse(body));
            } catch (err) {
                process.stderr.write(
                    `[lsp:${serverName}] JSON-RPC parse error: ${
                        err instanceof Error ? err.message : String(err)
                    }\n`
                );
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
                cwd: options?.cwd,
                windowsHide: true,
            });

            if (!proc.stdout || !proc.stdin) {
                throw new Error(`LSP server ${serverName}: stdio 不可用`);
            }

            proc.stdout.on("data", (chunk: Buffer) => {
                inputBuffer = Buffer.concat([inputBuffer, chunk]);
                parseMessages();
            });

            proc.stderr?.on("data", (data: Buffer) => {
                const out = data.toString().trim();
                if (out) process.stderr.write(`[lsp:${serverName}] ${out}\n`);
            });

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
            try {
                writeMessage({jsonrpc: "2.0", method, params});
            } catch (err) {
                process.stderr.write(`[lsp:${serverName}] notification ${method} 失败: ${err}\n`);
            }
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
