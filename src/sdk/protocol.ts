import type {StopReason} from "../agent/types.js";
import type {TurnAbortReason} from "../runtime/abort.js";
import type {FileChange} from "../fileChanges/index.js";
import type {HookTrustRequest} from "../hooks/index.js";
import type {MemoryChange} from "../memory/types.js";
import type {McpApprovalRequest} from "../mcp/index.js";
import type {AgentType} from "../subagents/types.js";
import type {Todo} from "../todos.js";

export interface Usage {
    inputTokens: number;
    outputTokens?: number;
    totalTokens?: number;
    estimated: boolean;
}

export interface SDKErrorInfo {
    code: string;
    message: string;
}

export type ThreadItemStatus =
    | "in_progress"
    | "completed"
    | "failed"
    | "denied"
    | "interrupted";

interface ThreadItemBase {
    id: string;
    status: ThreadItemStatus;
}

export interface AgentMessageItem extends ThreadItemBase {
    type: "agent_message";
    text: string;
    /** commentary 是 Turn 中途的进度说明；final 才能成为 finalResponse。 */
    phase: "commentary" | "final";
    responseId?: string;
}

export interface ToolCallItem extends ThreadItemBase {
    type: "tool_call";
    toolCallId: string;
    name: string;
    category: "builtin" | "command" | "mcp";
    arguments: unknown;
    resultPreview?: string;
    resultId?: string;
    resultByteLength?: number;
    resultComplete?: boolean;
    outcome?: "ok" | "failed" | "denied" | "interrupted";
}

export interface FileChangeItem extends ThreadItemBase {
    type: "file_change";
    parentToolCallId: string;
    changes: FileChange[];
}

interface InteractionRequestBase {
    requestId: string;
}

export type InteractionRequest =
    | (InteractionRequestBase & {
        kind: "permission";
        toolName: string;
        message: string;
        input: unknown;
        networkAccess?: {host: string; port: number};
    })
    | (InteractionRequestBase & {
        kind: "question";
        toolName: "ask_user";
        message: string;
        input: unknown;
    })
    | (InteractionRequestBase & {
        kind: "mcp_approval";
        request: McpApprovalRequest;
    })
    | (InteractionRequestBase & {
        kind: "hook_trust";
        request: HookTrustRequest;
    });

export type InteractionResponse =
    | {
        behavior: "allow";
        persistence?: "once" | "always";
        directoryScope?: "once" | "session" | "project";
        networkScope?: "once" | "session";
        answers?: Record<string, string>;
    }
    | {behavior: "deny"; message: string};

export interface InteractionItem extends ThreadItemBase {
    type: "interaction";
    request: InteractionRequest;
    resolution?: {
        behavior: "allow" | "deny";
        message?: string;
    };
}

export interface SubagentItem extends ThreadItemBase {
    type: "subagent";
    agentId: string;
    agentType: AgentType;
    agentName?: string;
    description: string;
    parentToolCallId: string;
    reason?: StopReason;
    iterations?: number;
    toolUseCount?: number;
    durationMs?: number;
    reportPreview?: string;
    transcriptPath?: string;
    error?: string;
}

export interface TodoListItem extends ThreadItemBase {
    type: "todo_list";
    todos: Todo[];
}

export interface CompactItem extends ThreadItemBase {
    type: "compact";
    trigger: "auto" | "manual";
    preTokenCount: number;
    threshold?: number;
    postTokenCount?: number;
    error?: string;
}

export interface MemoryChangeItem extends ThreadItemBase {
    type: "memory_change";
    source: "explicit" | "automatic";
    changes: MemoryChange[];
}

export interface DiagnosticItem extends ThreadItemBase {
    type: "diagnostic";
    severity: "info" | "warning" | "error";
    scope: string;
    message: string;
}

export type ThreadItem =
    | AgentMessageItem
    | ToolCallItem
    | FileChangeItem
    | InteractionItem
    | SubagentItem
    | TodoListItem
    | CompactItem
    | MemoryChangeItem
    | DiagnosticItem;

export interface EventEnvelope {
    protocolVersion: 1;
    sequence: number;
    threadId: string;
    turnId?: string;
    emittedAt: string;
}

export type TurnProgressPhase =
    | "model_waiting"
    | "reasoning"
    | "content"
    | "tool_input"
    | "retrying"
    | "stalled";

export type ThreadEventPayload =
    | {type: "turn.draft"; turnId: string; responseId: string; text: string; truncated: boolean}
    | {type: "turn.draft_end"; turnId: string; responseId: string; disposition: "committed" | "discarded"}
    | {type: "thread.started"}
    | {type: "turn.started"; turnId: string; inputSummary: string}
    | {
        type: "turn.progress";
        turnId: string;
        phase: TurnProgressPhase;
        outputCharacters: number;
        estimatedOutputTokens: number;
        toolName?: string;
        idleMilliseconds?: number;
    }
    | {type: "item.started"; turnId: string; item: ThreadItem}
    | {type: "item.updated"; turnId: string; item: ThreadItem}
    | {type: "item.completed"; turnId: string; item: ThreadItem}
    | {
        type: "turn.completed";
        turnId: string;
        usage: Usage | null;
        stopReason: StopReason;
        abortReason?: TurnAbortReason;
        iterations: number;
        durationMs: number;
        checkpointId?: string;
    }
    | {type: "turn.failed"; turnId: string; error: SDKErrorInfo};

export type ThreadEvent = ThreadEventPayload & EventEnvelope;
