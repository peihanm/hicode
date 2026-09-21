import type {Client} from "@modelcontextprotocol/sdk/client/index.js";
import type {Tool as McpSdkTool} from "@modelcontextprotocol/sdk/types.js";
import type {Tool} from "../tools/types.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";

export type McpConfigSource = "user" | "project";
export type McpSource = McpConfigSource | "host";
export type McpApprovalDecision = "once" | "always" | "deny" | "skip";

export interface McpStdioServerConfig {
    type: "stdio";
    command: string;
    args: string[];
    env?: Record<string, string>;
    disabled: boolean;
    timeoutMs: number;
    toolTimeoutMs: number;
}

export interface HostMcpServerContribution {
    name: string;
    type?: "stdio";
    command: string;
    args?: string[];
    env?: Record<string, string>;
    disabled?: boolean;
    timeoutMs?: number;
    toolTimeoutMs?: number;
}

interface LoadedMcpServerContent {
    name: string;
    config: McpStdioServerConfig;
}

export type LoadedMcpServerConfig = LoadedMcpServerContent & (
    | {source: McpConfigSource; path: string}
    | {source: "host"; id: string}
);

interface McpConfigIssueDetails {
    serverName?: string;
    message: string;
}

export type McpConfigIssue = McpConfigIssueDetails & (
    | {source: McpConfigSource; path: string}
    | {source: "host"; id: string}
);

export interface LoadedMcpConfig {
    servers: LoadedMcpServerConfig[];
    issues: McpConfigIssue[];
}

type McpServerStatus =
    | "pending-approval"
    | "denied"
    | "connecting"
    | "connected"
    | "refreshing"
    | "failed"
    | "disabled"
    | "closed";

export interface McpServerSnapshot {
    name: string;
    source: McpSource;
    status: McpServerStatus;
    toolCount: number;
    error?: string;
    catalog?: {
        notifications: number;
        revision: number;
        added: string[];
        changed: string[];
        removed: string[];
        unchanged: number;
    };
}

export interface McpApprovalRequest {
    projectPath: string;
    serverName: string;
    command: string;
    args: string[];
    configHash: string;
}

export interface McpConnectedServer {
    config: LoadedMcpServerConfig;
    client: Client;
    tools: McpSdkTool[];
    stderr: string;

    callTool(
        toolName: string,
        args: Record<string, unknown>,
        signal: AbortSignal
    ): Promise<unknown>;

    close(): Promise<void>;
}

export interface McpManagerOptions {
    storage: HiCodeStorageLayout;
    cwd: string;
    childEnvironment: ChildProcessEnvironment;
    signal?: AbortSignal;
    headless?: boolean;
    sources?: readonly McpConfigSource[];
    hostServers?: readonly HostMcpServerContribution[];
    requestApproval?: (
        request: McpApprovalRequest
    ) => Promise<McpApprovalDecision>;
}

export interface McpManagerLike {
    initialize(): Promise<void>;

    waitForRefresh(signal: AbortSignal): Promise<void>;

    getSnapshots(): readonly McpServerSnapshot[];

    getTools(): readonly Tool[];

    subscribe(listener: () => void): () => void;

    reconnect(name: string): Promise<void>;

    closeAll(): Promise<void>;
}
