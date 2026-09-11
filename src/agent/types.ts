import type {HookLifecycleEvent, HookInput} from "../hooks/types.js";
import type {TurnAbortReason} from "../runtime/abort.js";
import type {PersistedToolResult} from "../toolResults/index.js";
import type {AgentType} from "../subagents/types.js";
import type {ToolUIData} from "../fileChanges/index.js";
import type {LLMStreamProgress} from "../llm/types.js";
import type {MemoryChange} from "../memory/types.js";
import type {ApprovalEvent} from "../permissions/approval.js";

export type StopReason =
    | "completed"
    | "max_turns"
    | "permission_denied"
    | "hook_blocked"
    | "hook_error"
    | "hook_limit"
    | "no_tool_calls"
    | "interrupted";

export interface AgentResult {
    reply: string;
    reason: StopReason;
    iterations: number;
    abortReason?: TurnAbortReason;
    usage?: AgentUsage;
}

export interface AgentUsage {
    inputTokens: number;
    outputTokens?: number;
    totalTokens?: number;
    estimated: boolean;
}

/** Agent 主循环向宿主发布的运行事件。 */
export type AgentEvent =
    | ApprovalEvent
    | HookLifecycleEvent
    | {type: "turn_end"; input: Extract<HookInput, {hook_event_name: "TurnEnd"}>}
    | {
        type: "assistant_text";
        content: string;
        /** 省略时视为本地命令产生的最终文本。 */
        phase?: "commentary" | "final";
        responseId?: string;
    }
    | {type: "assistant_draft"; responseId: string; text: string; truncated: boolean}
    | {type: "assistant_draft_end"; responseId: string; disposition: "committed" | "discarded"}
    | {type: "model_stream_start"}
    | ({type: "model_stream_progress"} & LLMStreamProgress)
    | {type: "model_stream_end"}
    | {
        type: "compact_start";
        tokenCount: number;
        threshold: number;
        trigger: "auto" | "manual";
    }
    | {
        type: "compact_end";
        preTokenCount: number;
        postTokenCount: number;
        trigger: "auto" | "manual";
    }
    | {
        type: "compact_error";
        message: string;
        trigger: "auto" | "manual";
    }
    | {
        type: "tool_call_start";
        turnId: string;
        toolCallId: string;
        name: string;
        args: string;
    }
    | {
        type: "tool_call_end";
        turnId: string;
        toolCallId: string;
        result: string;
        outcome?: "ok" | "failed" | "denied" | "interrupted";
        persisted?: PersistedToolResult;
        uiData?: ToolUIData;
    }
    | {
        type: "tool_result_persisted";
        toolCallId: string;
        persisted: PersistedToolResult;
    }
    | {type: "turn_interrupted"; reason: TurnAbortReason}
    | {
        type: "subagent_start";
        agentId: string;
        agentType: AgentType;
        agentName?: string;
        description: string;
        parentToolCallId: string;
    }
    | {
        type: "subagent_end";
        agentId: string;
        agentType: AgentType;
        agentName?: string;
        reason: StopReason;
        iterations: number;
        toolUseCount: number;
        durationMs: number;
        report: string;
        transcriptPath?: string;
    }
    | {
        type: "subagent_progress";
        agentId: string;
        event:
            | {
                type: "tool_start";
                toolCallId: string;
                name: string;
                args: string;
            }
            | {
                type: "tool_end";
                toolCallId: string;
            }
            | {type: "token_update"; tokenCount: number};
    }
    | {
        type: "subagent_error";
        agentId: string;
        agentType: AgentType;
        agentName?: string;
        message: string;
    }
    | {type: "iteration"; current: number; max?: number}
    | {
        type: "token_update";
        tokenCount: number;
        percentUsed: number;
        warning: boolean;
        status: "estimated" | "actual";
    }
    | {
        type: "memory_update";
        source: "explicit" | "automatic";
        changes: MemoryChange[];
    };
