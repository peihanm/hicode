// LSP Manager：管理多个 LSP server，按文件后缀路由
// 参考 claude-code src/services/lsp/LSPServerManager.ts（420 行）
// 我们简化版 ~140 行：去掉 singleton state、诊断注册、detailed error handling
//
// 职责：
// 1. 加载配置（loadLspConfig）
// 2. 按文件后缀选 server
// 3. 确保 server 启动（lazy start）
// 4. 文件同步（didOpen/didChange/didSave/didClose）

import {extname, isAbsolute, relative, resolve, sep} from "path";
import {fileURLToPath, pathToFileURL} from "url";
import {readFile, stat} from "node:fs/promises";
import {loadLspConfig, type LspConfig} from "./config.js";
import {createLSPServerInstance, type LSPServerInstance} from "./serverInstance.js";
import type {Diagnostic, PublishDiagnosticsParams} from "vscode-languageserver-protocol";
import {normalizeTurnAbortReason, throwIfTurnAborted, TurnInterruptedError,} from "../runtime/abort.js";
import type {LspManagerLike} from "./types.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";

interface DiagnosticEntry {
    diagnostics: Diagnostic[];
    updatedAt: number;
}

const MAX_OPEN_FILES = 1024;
const MAX_DIAGNOSTIC_FILES = 256;
const MAX_DIAGNOSTICS_PER_FILE = 200;
const MAX_DIAGNOSTIC_MESSAGE_CHARS = 4096;
const MAX_OPEN_FILE_BYTES = 10 * 1024 * 1024;

class LSPManager implements LspManagerLike {
    private servers = new Map<string, LSPServerInstance>();
    // 后缀 → server name 列表（一个后缀可能多个 server，取第一个）
    private extensionMap = new Map<string, string>();
    // 已 didOpen 的文件 URI → server name
    private openedFiles = new Map<string, string>();
    private fileVersions = new Map<string, number>();
    private diagnosticCache = new Map<string, DiagnosticEntry>();
    private diagnosticWaiters = new Map<
        string,
        Array<(entry?: DiagnosticEntry) => void>
    >();
    private cwd: string;

    constructor(
        cwd: string,
        config: LspConfig,
        childEnvironment: ChildProcessEnvironment
    ) {
        this.cwd = cwd;
        this.loadConfig(config, childEnvironment);
    }

    private loadConfig(
        config: LspConfig,
        childEnvironment: ChildProcessEnvironment
    ) {
        for (const [name, serverConfig] of Object.entries(config)) {
            // 注册后缀映射
            for (const ext of serverConfig.extensions) {
                const normalized = ext.toLowerCase();
                if (!this.extensionMap.has(normalized)) {
                    this.extensionMap.set(normalized, name);
                }
            }
            // 创建 server instance（还没启动）
            const resolvedConfig = {
                ...serverConfig,
                workspaceFolder: serverConfig.workspaceFolder ?? this.cwd,
            };
            this.servers.set(
                name,
                createLSPServerInstance(name, resolvedConfig, childEnvironment, (params) =>
                    this.handleDiagnostics(params)
                )
            );
        }
    }

    // 按文件路径选 server
    getServerForFile(filePath: string): LSPServerInstance | undefined {
        const ext = extname(filePath).toLowerCase();
        const name = this.extensionMap.get(ext);
        if (!name) return undefined;
        return this.servers.get(name);
    }

    // 确保 server 启动
    async ensureServerStarted(
        filePath: string,
        signal?: AbortSignal
    ): Promise<LSPServerInstance | undefined> {
        if (signal) throwIfTurnAborted(signal);
        const server = this.getServerForFile(filePath);
        if (!server) return undefined;
        if (server.state === "stopped" || server.state === "error") {
            await server.start(signal);
        }
        return server;
    }

    // 文件打开（didOpen）
    async openFile(filePath: string, signal?: AbortSignal): Promise<void> {
        const server = await this.ensureServerStarted(filePath, signal);
        if (!server) return;

        const absPath = this.toAbsolute(filePath);
        const uri = this.uriForFile(filePath);
        if (this.openedFiles.get(uri) === server.name) return; // 已打开
        if (this.openedFiles.size >= MAX_OPEN_FILES) {
            throw new Error(`LSP 已打开文件达到 ${MAX_OPEN_FILES} 个上限`);
        }

        const ext = extname(filePath).toLowerCase();
        const languageId = languageIdForExtension(ext);
        const metadata = await stat(absPath);
        if (!metadata.isFile() || metadata.size > MAX_OPEN_FILE_BYTES) {
            throw new Error("LSP 只能打开不超过 10 MiB 的普通文件");
        }
        const content = await readFile(absPath, "utf-8");

        await server.sendNotification("textDocument/didOpen", {
            textDocument: {uri, languageId, version: 1, text: content},
        });
        this.openedFiles.set(uri, server.name);
        this.fileVersions.set(uri, 1);
    }

    // 文件变更（didChange）
    async changeFile(
        filePath: string,
        content: string,
        signal?: AbortSignal
    ): Promise<void> {
        const server = await this.ensureServerStarted(filePath, signal);
        if (!server || !server.isHealthy()) return;

        const uri = this.uriForFile(filePath);
        if (this.openedFiles.get(uri) !== server.name) {
            // 还没 didOpen，先 didOpen
            return this.openFile(filePath, signal);
        }

        const version = (this.fileVersions.get(uri) ?? 1) + 1;
        this.fileVersions.set(uri, version);

        await server.sendNotification("textDocument/didChange", {
            textDocument: {uri, version},
            contentChanges: [{text: content}],
        });
    }

    async saveFile(
        filePath: string,
        content?: string,
        signal?: AbortSignal
    ): Promise<void> {
        const server = await this.ensureServerStarted(filePath, signal);
        if (!server || !server.isHealthy()) return;

        const uri = this.uriForFile(filePath);
        if (this.openedFiles.get(uri) !== server.name) {
            await this.openFile(filePath, signal);
        }

        await server.sendNotification("textDocument/didSave", {
            textDocument: {uri},
            ...(content !== undefined ? {text: content} : {}),
        });
    }

    async syncFileAndGetDiagnostics(
        filePath: string,
        content: string,
        timeoutMs = 1200,
        signal?: AbortSignal
    ): Promise<Diagnostic[] | undefined> {
        const server = await this.ensureServerStarted(filePath, signal);
        if (!server || !server.isHealthy()) return undefined;

        const uri = this.uriForFile(filePath);
        const before = this.diagnosticCache.get(uri)?.updatedAt ?? 0;

        if (this.openedFiles.get(uri) === server.name) {
            await this.changeFile(filePath, content, signal);
        } else {
            await this.openFile(filePath, signal);
        }
        await this.saveFile(filePath, content, signal);

        return this.waitForDiagnostics(filePath, timeoutMs, before, signal);
    }

    async waitForDiagnostics(
        filePath: string,
        timeoutMs = 1200,
        afterUpdatedAt = 0,
        signal?: AbortSignal
    ): Promise<Diagnostic[] | undefined> {
        if (signal) throwIfTurnAborted(signal);
        const uri = this.uriForFile(filePath);
        const existing = this.diagnosticCache.get(uri);
        if (existing && existing.updatedAt > afterUpdatedAt) {
            return existing.diagnostics;
        }
        if (timeoutMs <= 0) return existing?.diagnostics;

        return new Promise((resolve, reject) => {
            let settled = false;
            let timer: NodeJS.Timeout;
            const removeWaiter = () => {
                const currentWaiters = this.diagnosticWaiters.get(uri) ?? [];
                const remaining = currentWaiters.filter((w) => w !== waiter);
                if (remaining.length > 0) this.diagnosticWaiters.set(uri, remaining);
                else this.diagnosticWaiters.delete(uri);
            };
            const cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                removeWaiter();
            };
            const waiter = (entry?: DiagnosticEntry) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(entry?.diagnostics);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new TurnInterruptedError(normalizeTurnAbortReason(signal?.reason)));
            };
            const waiters = this.diagnosticWaiters.get(uri) ?? [];
            waiters.push(waiter);
            this.diagnosticWaiters.set(uri, waiters);

            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(this.diagnosticCache.get(uri)?.diagnostics);
            }, timeoutMs);
            signal?.addEventListener("abort", onAbort, {once: true});
        });
    }

    // 关闭所有 server（退出时调用）
    async shutdown(): Promise<void> {
        for (const waiters of this.diagnosticWaiters.values()) {
            for (const waiter of waiters) waiter(undefined);
        }
        this.diagnosticWaiters.clear();
        await Promise.all(
            [...this.servers.values()].map((s) => s.stop().catch(() => {
            }))
        );
        this.servers.clear();
        this.extensionMap.clear();
        this.openedFiles.clear();
        this.fileVersions.clear();
        this.diagnosticCache.clear();
    }

    // 列出所有配置的 server（调试用）
    listServers(): { name: string; state: string; extensions: string[] }[] {
        return [...this.servers.values()].map((s) => ({
            name: s.name,
            state: s.state,
            extensions: s.config.extensions,
        }));
    }

    toAbsolute(filePath: string): string {
        return isAbsolute(filePath) ? filePath : resolve(this.cwd, filePath);
    }

    private uriForFile(filePath: string): string {
        return pathToFileURL(this.toAbsolute(filePath)).href;
    }

    private handleDiagnostics(params: PublishDiagnosticsParams): void {
        if (
            !params ||
            typeof params.uri !== "string" ||
            params.uri.length > 32_768 ||
            !Array.isArray(params.diagnostics)
        ) return;
        let filePath: string;
        try {
            filePath = fileURLToPath(params.uri);
        } catch {
            return;
        }
        const rel = relative(resolve(this.cwd), resolve(filePath));
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
        const diagnostics = params.diagnostics
            .filter((item) =>
                item &&
                typeof item === "object" &&
                typeof item.message === "string" &&
                item.range &&
                Number.isSafeInteger(item.range.start?.line) &&
                Number.isSafeInteger(item.range.start?.character) &&
                Number.isSafeInteger(item.range.end?.line) &&
                Number.isSafeInteger(item.range.end?.character) &&
                item.range.start.line >= 0 &&
                item.range.start.character >= 0 &&
                item.range.end.line >= 0 &&
                item.range.end.character >= 0
            )
            .slice(0, MAX_DIAGNOSTICS_PER_FILE)
            .map((item) => {
                const {source, ...rest} = item;
                return {
                    ...rest,
                    message: (typeof item.message === "string"
                        ? item.message
                        : item.message.value
                    ).slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS),
                    ...(typeof source === "string"
                        ? {source: source.slice(0, 256)}
                        : {}),
                };
            });
        const entry = {
            diagnostics,
            updatedAt: Date.now(),
        };
        if (
            !this.diagnosticCache.has(params.uri) &&
            this.diagnosticCache.size >= MAX_DIAGNOSTIC_FILES
        ) {
            const oldest = this.diagnosticCache.keys().next().value;
            if (typeof oldest === "string") this.diagnosticCache.delete(oldest);
        }
        this.diagnosticCache.set(params.uri, entry);

        const waiters = this.diagnosticWaiters.get(params.uri) ?? [];
        this.diagnosticWaiters.delete(params.uri);
        for (const waiter of waiters) {
            waiter(entry);
        }
    }
}

function languageIdForExtension(ext: string): string {
    const map: Record<string, string> = {
        ".js": "javascript",
        ".jsx": "javascriptreact",
        ".mjs": "javascript",
        ".cjs": "javascript",
        ".ts": "typescript",
        ".tsx": "typescriptreact",
        ".mts": "typescript",
        ".cts": "typescript",
        ".py": "python",
        ".pyi": "python",
    };
    const fallback = ext.replace(/^\./, "");
    return map[ext] ?? (fallback || "plaintext");
}

// 创建失败时 LSP 按可选能力降级，不能阻止主 Agent 启动。
// 实例由调用方持有并负责 shutdown，不注册任何进程级全局状态。
export async function createLspManager(
    storage: PillarStorageLayout,
    cwd: string,
    childEnvironment: ChildProcessEnvironment
): Promise<LspManagerLike | undefined> {
    try {
        return new LSPManager(
            cwd,
            await loadLspConfig(storage, cwd),
            childEnvironment
        );
    } catch {
        return undefined;
    }
}
