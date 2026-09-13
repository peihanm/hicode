import type {HookExecution} from "../../hooks/types.js";
import type {PersistedToolResult, ToolOutcome} from "../../toolResults/index.js";
import type {AgentType} from "../../subagents/types.js";
import type {FileChange, ToolUIData} from "../../fileChanges/index.js";

export type UIThread =
    | {id: string; role: "hook"; status: "running" | "done";
        execution: Omit<HookExecution, "outcome" | "durationMs"> & {outcome?: HookExecution["outcome"]; durationMs?: number}}
    | {id: string; role: "coordination_message"; text: string}
    | {id: string; role: "user"; text: string}
    | {id: string; role: "assistant"; text: string}
    | {
        id: string;
        role: "task_notification";
        taskId: string;
        ownerToolCallId?: string;
        kind: "shell" | "agent" | "memory";
        label: string;
        status: "completed" | "failed" | "cancelled" | "interrupted";
        summary: string;
        resultId?: string;
    }
    | {
        id: string;
        role: "tool_call";
        approvalReview?: string;
        turnId?: string;
        toolCallId: string;
        name: string;
        args: string;
        status: "running" | "done";
        outcome?: ToolOutcome;
        result?: string;
        persisted?: PersistedToolResult;
        subagentId?: string;
        subagentType?: AgentType;
        subagentName?: string;
        subagentReport?: string;
        subagentIterations?: number;
        subagentToolUseCount?: number;
        subagentDurationMs?: number;
        subagentTokenCount?: number;
        subagentTranscriptPath?: string;
        subagentProgress?: SubagentProgressItem[];
        uiData?: ToolUIData;
        hiddenByFileChange?: boolean;
    }
    | {
        id: string;
        role: "file_change_group";
        turnId: string;
        changes: FileChange[];
    };

export interface SubagentProgressItem {
    toolCallId: string;
    name: string;
    args: string;
    status: "running" | "done";
}
