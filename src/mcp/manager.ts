import {buildMcpToolName} from "./names.js";
import {stableJson} from "./json.js";
import {join} from "node:path";
import {createMcpApprovalIdentity, getMcpApproval, saveMcpApproval} from "./approval.js";
import {connectMcpServer} from "./client.js";
import {loadMcpConfig} from "./config.js";
import {adaptMcpTools} from "./toolAdapter.js";
import type {Tool} from "../tools/types.js";
import type {
    LoadedMcpServerConfig,
    McpConnectedServer,
    McpManagerLike,
    McpManagerOptions,
    McpServerSnapshot,
} from "./types.js";

interface MutableConnection {
    server: LoadedMcpServerConfig;
    snapshot: McpServerSnapshot;
    connected?: McpConnectedServer;
    tools: Tool[];
    generation: number;
    definitions: Map<string, {fingerprint: string; token: symbol}>;
    controller?: AbortController;
    pending?: Promise<void>;
    connecting?: Promise<void>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

class McpManager implements McpManagerLike {
    private connections: MutableConnection[] = [];
    private listeners = new Set<() => void>();
    private initialized = false;
    private closed = false;
    private closing: Promise<void> | undefined;

    constructor(private readonly options: McpManagerOptions) {
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // State observers cannot disrupt the Server lifecycle.
            }
        }
    }

    getSnapshots(): readonly McpServerSnapshot[] {
        return this.connections.map((item) => structuredClone(item.snapshot));
    }

    getTools(): readonly Tool[] {
        if (this.closed || this.options.signal?.aborted) return [];
        return this.connections.flatMap((item) => item.tools);
    }

    private async getApproval(server: LoadedMcpServerConfig, reviewDenied: boolean): Promise<"allow" | "deny" | "pending"> {
        if (this.closed || this.options.signal?.aborted) return "pending";
        if (server.source === "user") return "allow";
        const identity = await createMcpApprovalIdentity(this.options.cwd, server);
        const approvalPath = join(
            this.options.storage.hicodeHome,
            "mcp-approvals.json"
        );
        const stored = await getMcpApproval(approvalPath, identity, server.name);
        if (this.closed || this.options.signal?.aborted) return "pending";
        if (stored === "allow") return "allow";
        if ((stored === "deny" && !reviewDenied) || this.options.headless || !this.options.requestApproval) return stored;
        const decision = await this.options.requestApproval({
            projectPath: identity.projectPath,
            serverName: server.name,
            command: server.config.command,
            args: server.config.args,
            configHash: identity.configHash,
        });
        if (this.closed || this.options.signal?.aborted) return "pending";
        if (decision === "always" || decision === "deny") {
            await saveMcpApproval(approvalPath, identity, server.name, decision);
        }
        if (decision === "once" || decision === "always") return "allow";
        return decision === "deny" ? "deny" : stored;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        const loaded = await loadMcpConfig(
            this.options.storage,
            this.options.cwd,
            this.options.sources ?? ["user", "project"],
            this.options.hostServers ?? []
        );
        if (this.closed || this.options.signal?.aborted) return;
        this.connections = loaded.servers.map((server) => ({
            server,
            snapshot: {
                name: server.name,
                source: server.source,
                status: server.config.disabled ? "disabled" : "pending-approval",
                toolCount: 0,
            },
            tools: [], generation: 0, definitions: new Map(),
        }));
        for (const issue of loaded.issues) {
            const name = issue.serverName ?? `config:${issue.source}`;
            this.connections.push({
                server: issue.source === "host"
                    ? {
                        name,
                        source: "host",
                        id: issue.id,
                        config: {
                            type: "stdio",
                            command: "",
                            args: [],
                            disabled: true,
                            timeoutMs: 10_000,
                            toolTimeoutMs: 120_000,
                        },
                    }
                    : {
                        name,
                        source: issue.source,
                        path: issue.path,
                        config: {
                        type: "stdio",
                        command: "",
                        args: [],
                        disabled: true,
                        timeoutMs: 10_000,
                        toolTimeoutMs: 120_000,
                        },
                    },
                snapshot: {name, source: issue.source, status: "failed", toolCount: 0, error: issue.message},
                tools: [], generation: 0, definitions: new Map(),
            });
        }
        this.emit();

        const active: MutableConnection[] = [];
        for (const connection of this.connections) {
            if (connection.snapshot.status === "disabled" || connection.snapshot.status === "failed") continue;
            const approval = await this.getApproval(connection.server, false);
            if (approval !== "allow") {
                if (this.closed || this.options.signal?.aborted) break;
                connection.snapshot.status = approval === "deny" ? "denied" : "pending-approval";
                connection.snapshot.error = approval === "deny" ? "MCP Server was denied for this project" : "MCP Server has not been approved";
                continue;
            }
            active.push(connection);
        }

        let nextIndex = 0;
        const worker = async () => {
            while (
                nextIndex < active.length &&
                !this.closed &&
                !this.options.signal?.aborted
                ) {
                const connection = active[nextIndex++]!;
                await this.connect(connection);
            }
        };
        await Promise.all(Array.from({length: Math.min(3, active.length)}, () => worker()));
    }

    private invalidate(connection: MutableConnection, status: "closed" | "failed", error?: unknown): void {
        connection.tools = [];
        connection.definitions.clear();
        connection.snapshot.toolCount = 0;
        connection.snapshot.status = status;
        if (error !== undefined) connection.snapshot.error = errorMessage(error).slice(0, 2000);
        this.emit();
    }

    async waitForRefresh(signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        if (!this.connections.some(item => item.snapshot.status === "refreshing")) return;
        await new Promise<void>((resolve, reject) => {
            const finish = () => {
                if (!signal.aborted && this.connections.some(item => item.snapshot.status === "refreshing")) return;
                unsubscribe();
                signal.removeEventListener("abort", finish);
                if (signal.aborted) reject(signal.reason);
                else resolve();
            };
            const unsubscribe = this.subscribe(finish);
            signal.addEventListener("abort", finish, {once: true});
            finish();
        });
    }

    private publishTools(connection: MutableConnection, connected: McpConnectedServer, generation: number, strict = false): void {
        const definitions = new Map<string, {fingerprint: string; token: symbol}>();
        const callTokens = new Map<string, symbol>();
        const previous = new Map(connection.tools.map(tool => [tool.name, tool]));
        // Compare complete wire definitions, including annotations, before reusing capabilities.
        const added: string[] = [], changed: string[] = [];
        let unchanged = 0;
        const next: Tool[] = [];
        // Validate the full catalog before publishing any portion of it.
        const adapted = adaptMcpTools({...connected, callTool: async (name, args, signal) => {
            await this.waitForRefresh(signal);
            const qualifiedName = buildMcpToolName(connection.server.name, name);
            if (this.closed || this.options.signal?.aborted || connection.controller?.signal.aborted ||
                connection.generation !== generation || connection.snapshot.status !== "connected" ||
                !callTokens.has(qualifiedName) || connection.definitions.get(qualifiedName)?.token !== callTokens.get(qualifiedName)) {
                throw new Error("MCP tool definition changed or the server disconnected; use tool_search to rediscover it before retrying");
            }
            return connected.callTool(name, args, signal);
        }});
        if (strict && adapted.issues.length) throw new Error(adapted.issues.join("; ").slice(0, 2000));
        for (const tool of adapted.tools) {
            const remote = connected.tools.find(item => buildMcpToolName(connection.server.name, item.name) === tool.name)!;
            const fingerprint = stableJson(remote);
            const prior = connection.definitions.get(tool.name);
            const existing = previous.get(tool.name);
            const same = existing && prior?.fingerprint === fingerprint;
            const definition = same ? prior : {fingerprint, token: Symbol(tool.name)};
            definitions.set(tool.name, definition);
            callTokens.set(tool.name, definition.token);
            if (same) {
                next.push(existing);
                unchanged++;
            } else {
                next.push(tool);
                (existing ? changed : added).push(tool.name);
            }
        }
        const removed = [...previous.keys()].filter(name => !definitions.has(name));
        const oldCatalog = connection.snapshot.catalog;
        connection.definitions = definitions;
        connection.tools = next;
        connection.snapshot.status = "connected";
        connection.snapshot.toolCount = next.length;
        connection.snapshot.catalog = {notifications: oldCatalog?.notifications ?? 0,
            revision: (oldCatalog?.revision ?? 0) + Number(added.length + changed.length + removed.length > 0),
            added, changed, removed, unchanged};
        delete connection.snapshot.error;
        if (adapted.issues.length) connection.snapshot.error = adapted.issues.join("; ").slice(0, 2000);
        this.emit();
    }

    private async connect(connection: MutableConnection): Promise<void> {
        const generation = ++connection.generation;
        const controller = new AbortController();
        connection.controller = controller;
        const signal = AbortSignal.any([controller.signal, ...(this.options.signal ? [this.options.signal] : [])]);
        const current = () => !this.closed && !signal.aborted && generation === connection.generation;
        const pending = Promise.resolve().then(async () => {
            if (!current()) return;
            connection.snapshot.status = "connecting";
            delete connection.snapshot.error;
            this.emit();
            try {
                const connected = await connectMcpServer(connection.server, this.options.cwd, this.options.childEnvironment, signal,
                    () => { if (current()) {this.invalidate(connection, "closed"); controller.abort();} },
                    error => { if (current()) {this.invalidate(connection, "failed", error); controller.abort(); void connection.connected?.close();} },
                    server => { if (current()) {
                        if (server) this.publishTools(connection, server, generation, true);
                        else {
                            connection.snapshot.status = "refreshing";
                            const catalog = connection.snapshot.catalog;
                            if (catalog) catalog.notifications++;
                            this.emit();
                        }
                    } });
                if (!current()) { await connected.close(); return; }
                connection.connected = connected;
                this.publishTools(connection, connected, generation);
            } catch (error) {
                if (current()) this.invalidate(connection, "failed", error);
                controller.abort();
                await connection.connected?.close();
            }
        });
        connection.connecting = pending;
        try { await pending; } finally { if (connection.connecting === pending) delete connection.connecting; }
    }

    async reconnect(name: string): Promise<void> {
        if (this.closed || this.options.signal?.aborted) throw new Error("MCP Manager is closed");
        const connection = this.connections.find(item => item.snapshot.name === name);
        if (!connection) throw new Error(`Unknown MCP Server: ${name}`);
        if (connection.pending || connection.connecting) throw new Error("MCP Server is connecting");
        // Reserve this server across configuration and approval awaits too.
        const pending = Promise.resolve().then(() => this.reconnectConnection(connection));
        connection.pending = pending;
        try { await pending; } finally { if (connection.pending === pending) delete connection.pending; }
    }

    private async reconnectConnection(connection: MutableConnection): Promise<void> {
        connection.generation++;
        connection.controller?.abort();
        this.invalidate(connection, "closed");
        await connection.connected?.close();
        delete connection.connected;
        try {
            const loaded = await loadMcpConfig(this.options.storage, this.options.cwd,
                this.options.sources ?? ["user", "project"], this.options.hostServers ?? []);
            const issue = loaded.issues.find(item => item.serverName === connection.server.name || !item.serverName);
            if (issue) throw new Error(issue.message);
            const server = loaded.servers.find(item => item.name === connection.server.name);
            if (!server) throw new Error("MCP Server configuration was removed");
            if (this.closed || this.options.signal?.aborted) throw new Error("MCP Manager is closed");
            connection.server = server;
            connection.snapshot.source = server.source;
            if (server.config.disabled) { connection.snapshot.status = "disabled"; this.emit(); return; }
            if (this.closed || this.options.signal?.aborted) throw new Error("MCP Manager is closed");
            const approval = await this.getApproval(server, true);
            if (approval !== "allow") {
                if (!this.closed && !this.options.signal?.aborted) {
                    connection.snapshot.status = approval === "deny" ? "denied" : "pending-approval";
                    connection.snapshot.error = approval === "deny" ? "MCP Server was denied for this project" : "MCP Server has not been approved";
                    this.emit();
                }
                return;
            }
            if (this.closed || this.options.signal?.aborted) throw new Error("MCP Manager is closed");
            await this.connect(connection);
        } catch (error) {
            if (!this.closed) this.invalidate(connection, "failed", error);
            throw error;
        }
    }

    async closeAll(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        for (const item of this.connections) {
            item.generation++;
            item.controller?.abort();
            item.tools = [];
            item.definitions.clear();
            item.snapshot.status = "closed";
            item.snapshot.toolCount = 0;
        }
        this.closing = (async () => {
            await Promise.allSettled(this.connections.flatMap(item => [item.connected?.close(), item.connecting]));
            for (const item of this.connections) {
                if (item.snapshot.status === "connected" || item.snapshot.status === "connecting") {
                    item.snapshot.status = "closed";
                }
            }
            this.emit();
            this.listeners.clear();
        })();
        this.emit();
        return this.closing;
    }
}

export function createMcpManager(options: McpManagerOptions): McpManagerLike {
    return new McpManager(options);
}
