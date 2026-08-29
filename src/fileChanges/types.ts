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

type DiffUnavailableReason = "timeout" | "too_large" | "error";

export interface FileChange {
    version: 1;
    path: string;
    kind: "create" | "update" | "delete";
    /** 本轮内多次文件工具调用合并后的初始状态到最终状态。 */
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
};
