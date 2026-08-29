import type {AgentResult} from "../agent/index.js";
import type {AgentType, VerificationVerdict,} from "../subagents/types.js";
import type {McpServerSnapshot} from "../mcp/index.js";
import type {PermissionMode} from "../permissions/index.js";
import type {ResumeMode} from "../session/index.js";
import type {PersistedToolResult} from "../toolResults/index.js";
import type {FileChange, ToolUIData} from "../fileChanges/index.js";
import type {ResolvedPillarSettings} from "../settings/index.js";

export type HeadlessOutputFormat = "text" | "json";

export interface HeadlessOptions {
    cwd: string;
    settings: ResolvedPillarSettings;
    prompt: string;
    permissionMode?: PermissionMode;
    resumeMode: ResumeMode;
    outputFormat: HeadlessOutputFormat;
}

export interface HeadlessToolCall {
    toolCallId: string;
    name: string;
    args: string;
    result?: string;
    outcome: "running" | "ok" | "permission_denied" | "failed" | "interrupted";
    persisted?: PersistedToolResult;
    uiData?: ToolUIData;
}

export interface HeadlessSubagent {
    agentId: string;
    agentType: AgentType;
    description: string;
    status: "running" | "completed" | "failed" | "interrupted";
    reason?: AgentResult["reason"];
    iterations?: number;
    toolUseCount?: number;
    durationMs?: number;
    transcriptPath?: string;
    error?: string;
    verificationVerdict?: VerificationVerdict;
}

export interface HeadlessRunSummary {
    ok: boolean;
    exitCode: number;
    sessionId: string;
    reason: AgentResult["reason"];
    abortReason?: AgentResult["abortReason"];
    iterations: number;
    reply: string;
    permissionMode: PermissionMode;
    toolCalls: HeadlessToolCall[];
    permissionDenials: HeadlessToolCall[];
    toolFailures: HeadlessToolCall[];
    subagents: HeadlessSubagent[];
    fileChanges: FileChange[];
    mcpServers: McpServerSnapshot[];
}
