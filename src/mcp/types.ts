import type {Client} from "@modelcontextprotocol/sdk/client/index.js";
import type {Tool as McpSdkTool} from "@modelcontextprotocol/sdk/types.js";
import type {Tool} from "../tools/types.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";

export type McpConfigSource = "user" | "project";
export type McpSource = McpConfigSource | "host";
export type McpApprovalDecision = "enable" | "cancel";

export interface McpToolPolicy {
    exceptions: Partial<Record<string, "ask" | "deny">>;
}

interface McpServerOptions {
    disabled: boolean;
    timeoutMs: number;
    toolTimeoutMs: number;
}

export type HostMcpServerContribution = {
    name: string;
    disabled?: boolean;
    timeoutMs?: number;
    toolTimeoutMs?: number;
} & (
    | {type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>}
    | {type?: "http"; url: string}
);

interface LoadedMcpServerContent {
    name: string;
    config: McpServerOptions & (
        | {type: "stdio"; command: string; args: string[]; env?: Record<string, string>}
        | {type: "http"; url: string}
    );
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
    | "connecting"
    | "connected"
    | "refreshing"
    | "failed"
    | "disabled"
    | "closed";

export interface McpServerSnapshot {
    configHash?: string;
    toolPolicy?: McpToolPolicy;
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

export type McpApprovalRequest = {
    projectPath: string;
    serverName: string;
    configHash: string;
} & (
    | {type: "stdio"; command: string; args: string[]}
    | {type: "http"; url: string}
);

export interface McpConnectedServer {
    config: LoadedMcpServerConfig;
    client: Client;
    description?: string;
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

    getSnapshots(): readonly McpServerSnapshot[];

    getTools(): readonly Tool[];

    subscribe(listener: () => void): () => void;

    reconnect(name: string): Promise<void>;

    setToolPolicy(name: string, configHash: string, policy: McpToolPolicy): Promise<void>;

    closeAll(): Promise<void>;
}
