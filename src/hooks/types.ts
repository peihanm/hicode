export const HOOK_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
type HookConfigSource = "user" | "project" | "local";

interface ConditionalHookSettings {
    /**
     * 仅用于 Tool 事件的第二阶段过滤，复用权限规则语法，例如
     * `bash(git status:*)`。它只决定 Hook 是否执行，不改变工具权限。
     */
    if?: string;
    once?: boolean;
}

interface CommandHookSettings extends ConditionalHookSettings {
    type: "command";
    command: string;
    shell?: "bash" | "powershell";
    timeoutMs?: number;
}

interface PromptHookSettings extends ConditionalHookSettings {
    type: "prompt";
    prompt: string;
    timeoutMs?: number;
}

export type HookSettings = CommandHookSettings | PromptHookSettings;

interface HookMatcherSettings {
    matcher?: string;
    hooks: HookSettings[];
}

export type HooksSettingsFile = Partial<
    Record<HookEvent, HookMatcherSettings[]>
>;

export interface ResolvedHookMatcher extends HookMatcherSettings {
    source: HookConfigSource;
    path: string;
}

export type ResolvedHookSettings = Record<
    HookEvent,
    readonly ResolvedHookMatcher[]
>;

interface HookTrustSummary {
    event: HookEvent;
    type: HookSettings["type"];
    matcher?: string;
    condition?: string;
    shell?: "bash" | "powershell";
    once?: boolean;
    command?: string;
    prompt?: string;
    source: HookConfigSource;
    path: string;
}

export type HookTrustDecision = "once" | "always" | "deny";

export interface HookTrustRequest {
    projectPath: string;
    hooks: readonly HookTrustSummary[];
}

export type HookInput =
    | {
        hook_event_name: "SessionStart";
        session_id: string;
        source: "startup" | "resume";
        model: string;
    }
    | {
        hook_event_name: "UserPromptSubmit";
        session_id: string;
        permission_mode: string;
        prompt: string;
    }
    | {
        hook_event_name: "PreToolUse";
        session_id: string;
        permission_mode: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_call_id: string;
    }
    | {
        hook_event_name: "PostToolUse";
        session_id: string;
        permission_mode: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_call_id: string;
        tool_response: {
            outcome: "ok";
            content: string;
            persisted?: {
                result_id: string;
                byte_length: number;
                complete: boolean;
            };
        };
    }
    | {
        hook_event_name: "PostToolUseFailure";
        session_id: string;
        permission_mode: string;
        tool_name: string;
        tool_input: Record<string, unknown>;
        tool_call_id: string;
        tool_response: {
            outcome: "failed" | "denied" | "interrupted";
            content: string;
            persisted?: {
                result_id: string;
                byte_length: number;
                complete: boolean;
            };
        };
    }
    | {
        hook_event_name: "SessionEnd";
        session_id: string;
        reason: string;
    };

type HookCommandOutcome =
    | "success"
    | "blocking"
    | "error"
    | "interrupted";

export interface HookExecution {
    event: HookEvent;
    source: HookConfigSource;
    type: HookSettings["type"];
    handler: string;
    outcome: HookCommandOutcome;
    durationMs: number;
    exitCode?: number;
    message?: string;
}

export interface HookBatchResult {
    blocked: boolean;
    blockReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContexts: string[];
    executions: HookExecution[];
}

export interface HookRuntimeIssue {
    severity: "warning" | "error";
    message: string;
}

export interface HookRuntime {
    readonly enabled: boolean;
    /** 是否存在可能产生宿主副作用的 Command Hook。 */
    readonly mayRunCommands: boolean;
    readonly issues: readonly HookRuntimeIssue[];

    execute(
        input: HookInput,
        signal: AbortSignal,
        context?: HookExecutionContext
    ): Promise<HookBatchResult>;
}

export interface HookExecutionContext {
    /**
     * 由真实 Tool Runtime 提供。Hook Runtime 不持有 Tool Catalog，也不复制
     * 各工具的权限 matcher。
     */
    matchesToolCondition?: (
        condition: string,
        toolInput: Record<string, unknown>
    ) => Promise<boolean>;
    session?: HookSessionRuntime;
}

export interface HookSessionRuntime {
    /** 首次 claim 返回 true，后续同 key 返回 false。 */
    claimOnce(key: string): boolean;
}

export function createHookSessionRuntime(): HookSessionRuntime {
    const claimed = new Set<string>();
    return {
        claimOnce(key) {
            if (claimed.has(key)) return false;
            claimed.add(key);
            return true;
        },
    };
}

export function createEmptyResolvedHookSettings(): ResolvedHookSettings {
    return {
        SessionStart: [],
        UserPromptSubmit: [],
        PreToolUse: [],
        PostToolUse: [],
        PostToolUseFailure: [],
        SessionEnd: [],
    };
}

export function countResolvedHooks(settings: ResolvedHookSettings): number {
    return HOOK_EVENTS.reduce(
        (total, event) =>
            total + settings[event].reduce(
                (eventTotal, matcher) => eventTotal + matcher.hooks.length,
                0
            ),
        0
    );
}
