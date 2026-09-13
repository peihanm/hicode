import type {AgentMessaging} from "../runtime/agentMessaging.js";
import type {AgentInputChannel} from "../agent/inputChannel.js";
import type {AgentEvent, StopReason} from "../agent/types.js";
import type {ToolContext} from "../tools/types.js";
import type {ForkContextSnapshot} from "./fork.js";
import type {SubagentModelOverride} from "./model.js";

type AgentName = string;
export type AgentType = AgentName;
export type AgentSource = "builtin" | "user" | "project" | "host";
export type AgentFileSource = Exclude<AgentSource, "builtin" | "host">;

interface AgentDefinitionContent {
    agentType: AgentName;
    whenToUse: string;
    systemPrompt: string;
    allowedTools: readonly string[];
    model: SubagentModelOverride;
    // When unset, inherit the runtime safety limit; built-in Explore declares no dedicated limit.
    maxIterations?: number;
}

export type AgentDefinition = AgentDefinitionContent & (
    | {source: "builtin"}
    | {source: "user" | "project"; path: string}
    | {source: "host"; id: string}
);

interface AgentLoadIssueDetails {
    severity: "warning" | "error";
    field?: string;
    message: string;
}

export type AgentLoadIssue = AgentLoadIssueDetails & (
    | {source: "user" | "project"; path: string}
    | {source: "host"; id: string}
);

export interface LoadedCustomAgents {
    definitions: readonly AgentDefinition[];
    issues: readonly AgentLoadIssue[];
}

interface SubagentWorkspace {
    cwd?: string;
    readOnly?: boolean;
}

export interface SubagentRequest extends SubagentWorkspace {
    workspaceWriteApproved?: true;
    agentType: AgentName;
    name?: string;
    description: string;
    prompt: string;
    parentToolCallId: string;
    model?: SubagentModelOverride;
    /** Absent for fresh context; inherited history never grants file-read authority. */
    contextSnapshot?: ForkContextSnapshot;
}

export interface SubagentResult {
    agentId: string;
    agentType: AgentName;
    agentName?: string;
    description: string;
    reply: string;
    reason: StopReason;
    iterations: number;
    toolUseCount: number;
    durationMs: number;
    transcriptPath?: string;
    transcriptIssue?: string;
}

export type SubagentRunner = (
    request: SubagentRequest
) => Promise<SubagentResult>;

export interface SubagentThreadRunInput {
    taskId?: string;
    prompt: string;
    signal: AbortSignal;
    inputChannel: AgentInputChannel;
}

export interface SubagentThread {
    readonly agentId: string;

    run(input: SubagentThreadRunInput): Promise<SubagentResult>;
}

export interface CreateSubagentRunnerOptions {
    parentContext: ToolContext;
    onEvent: (event: AgentEvent) => void | Promise<void>;
}

export interface CreateSubagentThreadOptions extends CreateSubagentRunnerOptions {
    /** Background Tasks use their stable task identity as the Agent identity. */
    agentId: string;
    /** Task Runtime aggregates child progress; synchronous UI does not expand internal tool events. */
    onChildEvent?: (event: AgentEvent) => void | Promise<void>;
    /** Agent transcripts and tool artifacts remain in parent-project storage, even with a separate cwd. */
    storageCwd?: string;
    /** Background children receive only a parent-addressed messaging endpoint. */
    agentMessaging?: AgentMessaging;
}

export type CreateSubagentRunner = (
    options: CreateSubagentRunnerOptions
) => SubagentRunner;

export type CreateSubagentThread = (
    options: CreateSubagentThreadOptions,
    request: SubagentRequest
) => SubagentThread;
