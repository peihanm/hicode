import type {TurnAbortReason} from "../runtime/abort.js";
import type {PersistedToolResult} from "../toolResults/index.js";
import type {AgentType, VerificationVerdict,} from "../subagents/types.js";
import type {ToolUIData} from "../fileChanges/index.js";
import type {LLMStreamProgress} from "../llm/types.js";
import type {MemoryChange} from "../memory/types.js";

export type StopReason =
    | "completed"
    | "max_turns"
    | "permission_denied"
    | "hook_blocked"
    | "no_tool_calls"
    | "interrupted";

export interface AgentResult {
    reply: string;
    reason: StopReason;
    iterations: number;
    abortReason?: TurnAbortReason;
}

/** Agent 主循环向宿主发布的运行事件。 */
export type AgentEvent =
    | {type: "assistant_text"; content: string}
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
        verificationVerdict?: VerificationVerdict;
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
    | {type: "iteration"; current: number; max: number}
    | {
        type: "token_update";
        tokenCount: number;
        percentUsed: number;
        warning: boolean;
        /** 兼容 Provider 缺失流式 usage；省略按旧事件的 actual 处理。 */
        status?: "estimated" | "actual";
    }
    | {
        type: "memory_update";
        source: "explicit" | "automatic";
        changes: MemoryChange[];
    };
