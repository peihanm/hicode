import {createMcpApprovalIdentity, defaultMcpApprovalPath, getMcpApproval, saveMcpApproval} from "./approval.js";
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
    tools: Tool<any>[];
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class McpManager implements McpManagerLike {
    private connections: MutableConnection[] = [];
    private listeners = new Set<() => void>();
    private initialized = false;
    private closed = false;

    constructor(private readonly options: McpManagerOptions) {
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of this.listeners) listener();
    }

    getSnapshots(): readonly McpServerSnapshot[] {
        return this.connections.map((item) => ({...item.snapshot}));
    }

    getTools(): readonly Tool<any>[] {
        return this.connections.flatMap((item) => item.tools);
    }

    private async isApproved(server: LoadedMcpServerConfig): Promise<boolean> {
        if (server.source === "user") return true;
        const identity = await createMcpApprovalIdentity(this.options.cwd, server);
        const approvalPath = this.options.approvalPath ?? defaultMcpApprovalPath();
        const stored = await getMcpApproval(approvalPath, identity, server.name);
        if (stored === "allow") return true;
        if (stored === "deny" || this.options.headless || !this.options.requestApproval) return false;
        const decision = await this.options.requestApproval({
            projectPath: identity.projectPath,
            serverName: server.name,
            command: server.config.command,
            args: server.config.args,
            configHash: identity.configHash,
        });
        if (decision === "always" || decision === "deny") {
            await saveMcpApproval(approvalPath, identity, server.name, decision);
        }
        return decision === "once" || decision === "always";
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        this.initialized = true;
        const loaded = await loadMcpConfig(this.options);
        this.connections = loaded.servers.map((server) => ({
            server,
            snapshot: {
                name: server.name,
                source: server.source,
                status: server.config.disabled ? "disabled" : "pending-approval",
                toolCount: 0,
            },
            tools: [],
        }));
        for (const issue of loaded.issues) {
            const name = issue.serverName ?? `config:${issue.source}`;
            this.connections.push({
                server: {
                    name,
                    source: issue.source,
                    path: issue.path,
                    config: {
                        type: "stdio",
                        command: "",
                        args: [],
                        disabled: true,
                        timeoutMs: 10_000,
                        toolTimeoutMs: 120_000
                    },
                },
                snapshot: {name, source: issue.source, status: "failed", toolCount: 0, error: issue.message},
                tools: [],
            });
        }
        this.emit();

        const active: MutableConnection[] = [];
        for (const connection of this.connections) {
            if (connection.snapshot.status === "disabled" || connection.snapshot.status === "failed") continue;
            if (!(await this.isApproved(connection.server))) {
                connection.snapshot.status = "pending-approval";
                connection.snapshot.error = "项目 MCP Server 尚未批准";
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
                connection.snapshot.status = "connecting";
                delete connection.snapshot.error;
                this.emit();
                try {
                    const connected = await connectMcpServer(
                        connection.server,
                        this.options.cwd,
                        this.options.signal,
                        () => {
                            if (connection.snapshot.status === "connected") {
                                connection.snapshot.status = "closed";
                                this.emit();
                            }
                        },
                        (error) => {
                            connection.snapshot.error = errorMessage(error).slice(0, 2000);
                            this.emit();
                        }
                    );
                    if (this.closed || this.options.signal?.aborted) {
                        await connected.close();
                        continue;
                    }
                    const adapted = adaptMcpTools(connected);
                    connection.connected = connected;
                    connection.tools = adapted.tools;
                    connection.snapshot.status = "connected";
                    connection.snapshot.toolCount = adapted.tools.length;
                    if (adapted.issues.length > 0) connection.snapshot.error = adapted.issues.join("; ").slice(0, 2000);
                } catch (error) {
                    connection.snapshot.status = "failed";
                    connection.snapshot.error = errorMessage(error).slice(0, 2000);
                }
                this.emit();
            }
        };
        await Promise.all(Array.from({length: Math.min(3, active.length)}, () => worker()));
    }

    async closeAll(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await Promise.allSettled(this.connections.map((item) => item.connected?.close()));
        for (const item of this.connections) {
            if (item.snapshot.status === "connected" || item.snapshot.status === "connecting") {
                item.snapshot.status = "closed";
            }
        }
        this.emit();
    }
}

export function createMcpManager(options: McpManagerOptions): McpManager {
    return new McpManager(options);
}
