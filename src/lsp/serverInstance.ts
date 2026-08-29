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

// LSP error code for "content modified" - server 状态变了（如 rust-analyzer 还在索引）
// 参考 claude-code LSP_ERROR_CONTENT_MODIFIED
const LSP_ERROR_CONTENT_MODIFIED = -32801;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

type ServerState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface LSPServerInstance {
    readonly name: string;
    readonly config: LspServerConfig;
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
        config: LspServerConfig,
        onDiagnostics?: (params: PublishDiagnosticsParams) => void
    ): LSPServerInstance {
        let state: ServerState = "stopped";
        let client: LSPClient | undefined;
        let crashRecoveryCount = 0;
        const maxRestarts = 3;

        const markFailure = () => {
            if (state !== "error") {
                crashRecoveryCount += 1;
            }
            state = "error";
        };

        // crash 回调：client 进程意外退出时调用
        const onCrash = (err: Error) => {
            markFailure();
            process.stderr.write(`[lsp:${name}] ${err.message}\n`);
        };

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
                if (state === "running" || state === "starting") return;

                // 超过 max restarts 不再重试
                if (state === "error" && crashRecoveryCount >= maxRestarts) {
                    throw new Error(`LSP server '${name}' exceeded max crash recovery (${maxRestarts})`);
                }

                try {
                    state = "starting";
                    client = createClient(name, onCrash);

                    const command = config.command;
                    const args = config.args ?? [];
                    const cwd = config.workspaceFolder ?? process.cwd();

                    await client.start(command, args, {cwd});
                    client.onNotification<PublishDiagnosticsParams>(
                        "textDocument/publishDiagnostics",
                        (params) => onDiagnostics?.(params)
                    );

                    // initialize
                    const workspaceUri = pathToFileURL(cwd).href;
                    await client.initialize({
                        processId: process.pid,
                        workspaceFolders: [{uri: workspaceUri, name: basename(cwd)}],
                        rootUri: workspaceUri,
                        capabilities: {
                            textDocument: {
                                synchronization: {didSave: true},
                                hover: {contentFormat: ["markdown", "plaintext"]},
                                definition: {linkSupport: true},
                                references: {},
                                documentSymbol: {hierarchicalDocumentSymbolSupport: true},
                            },
                        },
                    }, signal);

                    state = "running";
                    crashRecoveryCount = 0;
                } catch (err) {
                    if (isTurnInterruptedError(err, signal)) {
                        state = "stopping";
                        await client?.stop().catch(() => {
                        });
                        client = undefined;
                        state = "stopped";
                        throw err;
                    }
                    markFailure();
                    await client?.stop().catch(() => {
                    });
                    throw err;
                }
            },

            async stop() {
                if (state === "stopped" || state === "stopping") return;
                state = "stopping";
                try {
                    await client?.stop();
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
                    } catch (err: any) {
                        lastErr = err;
                        // 检查是不是 content modified 错误
                        const code = err?.data?.code ?? err?.code;
                        if (code === LSP_ERROR_CONTENT_MODIFIED && attempt < MAX_RETRIES - 1) {
                            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
                            if (signal) await abortableDelay(delay, signal);
                            else await new Promise((r) => setTimeout(r, delay));
                            continue;
                        }
                        throw err;
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
