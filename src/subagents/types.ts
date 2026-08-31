import type {AgentInputChannel} from "../agent/inputChannel.js";
import type {AgentEvent, StopReason} from "../agent/types.js";
import type {ToolContext} from "../tools/types.js";
import type {ForkContextSnapshot} from "./fork.js";
import type {SubagentModelOverride} from "./model.js";

type AgentName = string;
export type AgentType = AgentName;
export type AgentSource = "builtin" | "user" | "project" | "host";
export type AgentFileSource = Exclude<AgentSource, "builtin" | "host">;
export type VerificationVerdict = "PASS" | "FAIL" | "PARTIAL";

interface AgentDefinitionContent {
    agentType: AgentName;
    whenToUse: string;
    systemPrompt: string;
    allowedTools: readonly string[];
    model: SubagentModelOverride;
    // 未设置时继承主运行时的安全上限；内置 Explore 不声明专属上限。
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

export interface RegisteredSubagentRequest {
    kind?: "registered";
    agentType: AgentName;
    description: string;
    prompt: string;
    parentToolCallId: string;
    model?: SubagentModelOverride;
}

export interface ForkSubagentRequest {
    kind: "fork";
    agentType: "fork";
    name: string;
    description: string;
    prompt: string;
    parentToolCallId: string;
    isolation?: "worktree";
    contextSnapshot: ForkContextSnapshot;
}

export type SubagentRequest = RegisteredSubagentRequest | ForkSubagentRequest;

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
    verificationVerdict?: VerificationVerdict;
}

export type SubagentRunner = (
    request: SubagentRequest
) => Promise<SubagentResult>;

export interface SubagentThreadRunInput {
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
    /** 后台 Task 使用独立 signal；同步调用省略并继承 parentContext.signal。 */
    signal?: AbortSignal;
    /** 后台 Task 使用稳定 task identity 作为 agent identity。 */
    agentId?: string;
    /** 仅供 Task Runtime 汇总 child progress；同步 UI 不展开内部工具事件。 */
    onChildEvent?: (event: AgentEvent) => void | Promise<void>;
    /** Worktree Agent 的 transcript/tool artifacts 仍归父项目存储。 */
    storageCwd?: string;
}

export type CreateSubagentRunner = (
    options: CreateSubagentRunnerOptions
) => SubagentRunner;

export type CreateSubagentThread = (
    options: Omit<CreateSubagentRunnerOptions, "signal" | "agentId"> & {
        agentId: string;
    },
    request: SubagentRequest
) => SubagentThread;
