import type {Client} from "@modelcontextprotocol/sdk/client/index.js";
import type {Tool as McpSdkTool} from "@modelcontextprotocol/sdk/types.js";
import type {Tool} from "../tools/types.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";

export type McpConfigSource = "user" | "project";
export type McpApprovalDecision = "once" | "always" | "deny";

interface McpStdioServerConfig {
    type: "stdio";
    command: string;
    args: string[];
    env?: Record<string, string>;
    disabled: boolean;
    timeoutMs: number;
    toolTimeoutMs: number;
}

export interface LoadedMcpServerConfig {
    name: string;
    source: McpConfigSource;
    path: string;
    config: McpStdioServerConfig;
}

export interface McpConfigIssue {
    source: McpConfigSource;
    path: string;
    serverName?: string;
    message: string;
}

export interface LoadedMcpConfig {
    servers: LoadedMcpServerConfig[];
    issues: McpConfigIssue[];
}

type McpServerStatus =
    | "pending-approval"
    | "connecting"
    | "connected"
    | "failed"
    | "disabled"
    | "closed";

export interface McpServerSnapshot {
    name: string;
    source: McpConfigSource;
    status: McpServerStatus;
    toolCount: number;
    error?: string;
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
    storage: PillarStorageLayout;
    cwd: string;
    childEnvironment: ChildProcessEnvironment;
    signal?: AbortSignal;
    headless?: boolean;
    requestApproval?: (
        request: McpApprovalRequest
    ) => Promise<McpApprovalDecision>;
}

export interface McpManagerLike {
    initialize(): Promise<void>;

    getSnapshots(): readonly McpServerSnapshot[];

    getTools(): readonly Tool[];

    subscribe(listener: () => void): () => void;

    closeAll(): Promise<void>;
}
