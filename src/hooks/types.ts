import type {PersistedToolResult, ToolResultStore} from "../toolResults/index.js";

export const HOOK_EVENTS = [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "PostToolBatch", "Stop", "TurnEnd", "PreCompact", "PostCompact",
    "SubagentStart", "SubagentStop", "SessionEnd",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
type HookConfigSource = "user" | "project" | "local" | "host";
type HookConfigurationOrigin =
    | {source: Exclude<HookConfigSource, "host">; path: string}
    | {source: "host"; id: string};
export type HookPurpose = "control" | "observe";
interface HandlerSettings {
    purpose: HookPurpose;
    if?: string;
    once?: boolean;
    timeoutMs?: number;
}
export type HookCommand =
    | {command: string; shell?: "bash" | "powershell"; executable?: never; args?: never}
    | {executable: string; args: string[]; command?: never; shell?: never};
export type HookSettings = HandlerSettings & (
    | ({type: "command"} & HookCommand)
    | {type: "prompt"; prompt: string}
);
interface HookMatcherSettings {
    matcher?: string;
    /** 匹配组参与的 dispatch 总期限，最大 30 秒（清理事件更短）。 */
    timeoutMs?: number;
    hooks: HookSettings[];
}
export type HooksSettingsFile = Partial<Record<HookEvent, HookMatcherSettings[]>>;
export type ResolvedHookMatcher = HookMatcherSettings & HookConfigurationOrigin;
export type ResolvedHookSettings = Record<HookEvent, readonly ResolvedHookMatcher[]>;
export type HookTrustSummary = {
    hookId: string;
    event: HookEvent;
    type: HookSettings["type"];
    purpose: HookPurpose;
    matcher?: string;
    condition?: string;
    shell?: "bash" | "powershell";
    once?: boolean;
    command?: string;
    executable?: string;
    args?: string[];
    prompt?: string;
    timeoutMs?: number;
    dispatchTimeoutMs?: number;
} & HookConfigurationOrigin;
export type HookTrustDecision = "once" | "always" | "deny";
export interface HookTrustRequest {projectPath: string; hooks: readonly HookTrustSummary[]}

interface ToolHookInput {
    permission_mode: string;
    tool_name: string;
    tool_input: Record<string, unknown>;
    tool_call_id: string;
}
interface HookToolResponse {
    content: string;
    persisted?: {result_id: string; byte_length: number; complete: boolean};
}
interface SubagentHookInput {
    parent_turn_id: string;
    agent_id: string;
    agent_type: string;
    run_count: number;
    child_cwd: string;
    task_id?: string;
}
export type HookInput = {session_id: string; turn_id?: string} & (
    | {hook_event_name: "SessionStart"; source: "startup" | "resume"; model: string}
    | {hook_event_name: "UserPromptSubmit"; permission_mode: string; prompt: string}
    | ({hook_event_name: "PreToolUse"} & ToolHookInput)
    | ({hook_event_name: "PostToolUse"; tool_response: HookToolResponse & {outcome: "ok"}} & ToolHookInput)
    | ({hook_event_name: "PostToolUseFailure"; tool_response: HookToolResponse & {outcome: "failed"}} & ToolHookInput)
    | {hook_event_name: "PostToolBatch"; batch_id: string; status: "completed" | "interrupted" | "failed";
        tools: {tool_call_id: string; name: string; outcome: "ok" | "failed" | "denied" | "interrupted";
            summary: string; result_id?: string; changes: {path: string; kind: "create" | "update" | "delete"}[]}[]}
    | {hook_event_name: "Stop"; candidate: string; continuation_used: boolean}
    | {hook_event_name: "TurnEnd"; status: "completed" | "failed" | "cancelled" | "blocked" | "limit";
        reason: string; persistence_status: "saved" | "failed"; checkpoint_status: "settled" | "failed"}
    | {hook_event_name: "PreCompact"; trigger: "auto" | "manual"; token_count: number; instructions?: string}
    | {hook_event_name: "PostCompact"; trigger: "auto" | "manual"; status: "success" | "failed" | "cancelled";
        pre_token_count: number; post_token_count: number; reason?: string}
    | ({hook_event_name: "SubagentStart"} & SubagentHookInput)
    | ({hook_event_name: "SubagentStop"; status: "completed" | "failed" | "cancelled"; reason: string} & SubagentHookInput)
    | {hook_event_name: "SessionEnd"; reason: string}
);
export interface HookEnvelope {
    version: 2;
    cwd: string;
    hook_id: string;
    dispatch_id: string;
    execution_id: string;
    source: HookConfigurationOrigin;
    purpose: HookPurpose;
    event: HookInput;
    truncated?: true;
    original_bytes?: number;
    input_result_id?: string;
}
export interface HookHandlerExecution {
    event: HookEvent;
    source: HookConfigSource;
    type: HookSettings["type"];
    handler: string;
    outcome: "success" | "blocking" | "error" | "interrupted" | "skipped_budget";
    durationMs: number;
    exitCode?: number;
    message?: string;
    userMessage?: string;
    commandInvoked?: true;
}
export interface HookExecution extends HookHandlerExecution {
    hookId: string;
    dispatchId: string;
    executionId: string;
    startedAt: string;
    purpose: HookPurpose;
    artifact?: PersistedToolResult;
}
export interface HookBatchResult {
    blocked: boolean;
    blockReason?: string;
    error?: string;
    continueReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContexts: string[];
    executions: HookExecution[];
}
export interface HookRuntimeIssue {severity: "warning" | "error"; message: string}
export type HookLifecycleEvent =
    | {type: "hook_started"; execution: Omit<HookExecution, "outcome" | "durationMs">}
    | {type: "hook_completed"; execution: HookExecution};
export interface HookRuntime {
    readonly enabled: boolean;
    readonly issues: readonly HookRuntimeIssue[];
    hasToolHooks(toolName: string): boolean;
    inspect(): readonly (HookTrustSummary & {approved: boolean})[];
    reload(settings: ResolvedHookSettings, signal: AbortSignal): Promise<void>;
    execute(input: HookInput, signal: AbortSignal, context?: HookExecutionContext): Promise<HookBatchResult>;
}
export interface HookExecutionContext {
    matchesToolCondition?: (condition: string, toolInput: Record<string, unknown>) => Promise<boolean>;
    session?: HookSessionRuntime;
    store?: ToolResultStore;
    onEvent?: (event: HookLifecycleEvent) => void | Promise<void>;
}
export interface HookSessionRuntime {
    claimOnce(key: string): boolean;
    wasClaimed(key: string): boolean;
    record(event: HookLifecycleEvent): void;
    recent(): readonly (Omit<HookExecution, "outcome" | "durationMs"> & {outcome: HookExecution["outcome"] | "running"; durationMs?: number})[];
}
export function createHookSessionRuntime(): HookSessionRuntime {
    const claimed = new Set<string>();
    const executions: ReturnType<HookSessionRuntime["recent"]>[number][] = [];
    return {
        claimOnce(key) {if (claimed.has(key)) return false; claimed.add(key); return true;},
        wasClaimed: key => claimed.has(key),
        record(event) {
            const index = executions.findIndex(item => item.executionId === event.execution.executionId);
            const value = event.type === "hook_started"
                ? {...event.execution, outcome: "running" as const} : event.execution;
            if (index >= 0) executions[index] = value;
            else executions.push(value);
            if (executions.length > 100) executions.splice(0, executions.length - 100);
        },
        recent: () => executions.map(item => ({...item})),
    };
}
