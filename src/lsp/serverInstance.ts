// LSP Server Instance：管理单个 LSP server 的生命周期
// 参考 claude-code src/services/lsp/LSPServerInstance.ts（511 行）
// 我们简化版 ~180 行：state machine + crash recovery + retry on transient errors
//
// State machine:
//   stopped → starting → running
//   running → stopping → stopped
//   any → error (on failure)
//   error → starting (on retry, if crashRecoveryCount <= maxRestarts)

import {pathToFileURL} from "url";
import {basename} from "path";
import {createLSPClient, type LSPClient} from "./client.js";
import type {LspServerConfig} from "./config.js";
import type {PublishDiagnosticsParams} from "vscode-languageserver-protocol";
import {abortableDelay, isTurnInterruptedError, throwIfTurnAborted,} from "../runtime/abort.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";

// LSP error code for "content modified" - server 状态变了（如 rust-analyzer 还在索引）
// 参考 claude-code LSP_ERROR_CONTENT_MODIFIED
const LSP_ERROR_CONTENT_MODIFIED = -32801;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

type ServerState = "stopped" | "starting" | "running" | "stopping" | "error";
type ResolvedLspServerConfig = Omit<LspServerConfig, "workspaceFolder"> & {
    workspaceFolder: string;
};

export interface LSPServerInstance {
    readonly name: string;
    readonly config: ResolvedLspServerConfig;
    readonly state: ServerState;

    start(signal?: AbortSignal): Promise<void>;

    stop(): Promise<void>;

    isHealthy(): boolean;

    sendRequest<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;

    sendNotification(method: string, params: unknown): Promise<void>;
}

interface LSPServerInstanceDependencies {
    createClient: typeof createLSPClient;
}

export function createLSPServerInstanceFactory(
    overrides: Partial<LSPServerInstanceDependencies> = {}
) {
    const createClient = overrides.createClient ?? createLSPClient;

    return function createLSPServerInstance(
        name: string,
        config: ResolvedLspServerConfig,
        childEnvironment: ChildProcessEnvironment,
        onDiagnostics?: (params: PublishDiagnosticsParams) => void
    ): LSPServerInstance {
        let state: ServerState = "stopped";
        let client: LSPClient | undefined;
        let startPromise: Promise<void> | undefined;
        let crashRecoveryCount = 0;
        const maxRestarts = 3;

        const markFailure = () => {
            if (state !== "error") {
                crashRecoveryCount += 1;
            }
            state = "error";
        };
        const isStopping = () => state === "stopping";

        return {
            get name() {
                return name;
            },
            get config() {
                return config;
            },
            get state() {
                return state;
            },

            async start(signal) {
                if (signal) throwIfTurnAborted(signal);
                if (state === "running") return;
                if (startPromise) return startPromise;
                if (state === "stopping") {
                    throw new Error(`LSP server '${name}' is stopping`);
                }

                // 超过 max restarts 不再重试
                if (state === "error" && crashRecoveryCount >= maxRestarts) {
                    throw new Error(`LSP server '${name}' exceeded max crash recovery (${maxRestarts})`);
                }

                const task = (async () => {
                    let nextClient: LSPClient | undefined;
                    try {
                        state = "starting";
                        nextClient = createClient(name, () => {
                            if (client === nextClient && state !== "stopping") {
                                markFailure();
                            }
                        });
                        client = nextClient;

                        const command = config.command;
                        const args = config.args;
                        const cwd = config.workspaceFolder;

                        await nextClient.start(command, args, {
                            cwd,
                            environment: childEnvironment,
                        });
                        nextClient.onNotification<PublishDiagnosticsParams>(
                            "textDocument/publishDiagnostics",
                            (params) => onDiagnostics?.(params)
                        );

                        const workspaceUri = pathToFileURL(cwd).href;
                        await nextClient.initialize({
                            processId: process.pid,
                            workspaceFolders: [{
                                uri: workspaceUri,
                                name: basename(cwd),
                            }],
                            rootUri: workspaceUri,
                            capabilities: {
                                textDocument: {
                                    synchronization: {didSave: true},
                                    hover: {
                                        contentFormat: ["markdown", "plaintext"],
                                    },
                                    definition: {linkSupport: true},
                                    references: {},
                                    documentSymbol: {
                                        hierarchicalDocumentSymbolSupport: true,
                                    },
                                },
                            },
                        }, signal);

                        if (client !== nextClient || isStopping()) {
                            await nextClient.stop().catch(() => undefined);
                            return;
                        }
                        state = "running";
                    } catch (error) {
                        const interrupted = isTurnInterruptedError(error, signal);
                        const wasStopping = isStopping();
                        await nextClient?.stop().catch(() => undefined);
                        if (client === nextClient) client = undefined;
                        if (interrupted || wasStopping) {
                            state = "stopped";
                        } else {
                            markFailure();
                        }
                        throw error;
                    }
                })();
                startPromise = task;
                try {
                    await task;
                } finally {
                    if (startPromise === task) startPromise = undefined;
                }
            },

            async stop() {
                if (state === "stopped" && !startPromise) return;
                if (state === "stopping") {
                    await startPromise?.catch(() => undefined);
                    return;
                }
                state = "stopping";
                const activeClient = client;
                try {
                    await activeClient?.stop();
                    await startPromise?.catch(() => undefined);
                    if (client && client !== activeClient) {
                        await client.stop().catch(() => undefined);
                    }
                } finally {
                    state = "stopped";
                    client = undefined;
                }
            },

            isHealthy() {
                return state === "running" && (client?.isInitialized ?? false);
            },

            async sendRequest<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
                if (!this.isHealthy()) {
                    throw new Error(`LSP server '${name}' not healthy (state=${state})`);
                }

                // retry on "content modified"（如 rust-analyzer 还在索引）
                let lastErr: unknown;
                for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                    if (signal) throwIfTurnAborted(signal);
                    try {
                        return await client!.sendRequest<T>(method, params, signal);
                    } catch (error) {
                        lastErr = error;
                        // 检查是不是 content modified 错误
                        const record = error && typeof error === "object"
                            ? error as {code?: unknown; data?: unknown}
                            : undefined;
                        const data = record?.data &&
                            typeof record.data === "object"
                            ? record.data as {code?: unknown}
                            : undefined;
                        const code = data?.code ?? record?.code;
                        if (code === LSP_ERROR_CONTENT_MODIFIED && attempt < MAX_RETRIES - 1) {
                            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                            if (signal) await abortableDelay(delay, signal);
                            else await new Promise((r) => setTimeout(r, delay));
                            continue;
                        }
                        throw error;
                    }
                }
                throw lastErr;
            },

            async sendNotification(method: string, params: unknown): Promise<void> {
                if (!this.isHealthy()) return;
                await client!.sendNotification(method, params);
            },
        };
    };
}

export const createLSPServerInstance = createLSPServerInstanceFactory();
