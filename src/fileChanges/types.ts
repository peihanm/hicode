import type {AgentReceipt} from "../tools/agent/receipt.js";
import type {ToolOutcome} from "../toolResults/types.js";
export type DiffLineType = "context" | "add" | "remove";

export interface DiffLine {
    type: DiffLineType;
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

type DiffUnavailableReason = "timeout" | "too_large" | "binary" | "error";

export interface FileChange {
    version: 1;
    path: string;
    kind: "create" | "update" | "delete";
    /** Initial-to-final state after merging file-tool changes in this Turn. */
    scope?: "turn";
    hunks: DiffHunk[];
    linesAdded: number | null;
    linesRemoved: number | null;
    replacements?: number;
    diffStatus: "complete" | "truncated" | "unavailable";
    omittedDiffLines?: number;
    diffUnavailableReason?: DiffUnavailableReason;
}

export type ToolUIData = {
    type: "file_change";
    change: FileChange;
} | {type: "agent_receipt"; receipt: AgentReceipt};

export function toolFileChanges(data?: ToolUIData, outcome?: ToolOutcome): readonly FileChange[] {
    if (!data || data.type !== "file_change" || (outcome !== undefined && outcome !== "ok")) return [];
    return [data.change];
}
