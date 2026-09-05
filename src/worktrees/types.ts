import type {ToolContext} from "../tools/types.js";

export type WorktreeState = "active" | "changed" | "cleaned";

export type WorktreeCleanupReason = "no_changes" | "explicit_discard";

export interface WorktreeChangedFile {
    path: string;
    originalPath?: string;
    kind:
        | "create"
        | "update"
        | "delete"
        | "rename"
        | "copy"
        | "conflict"
        | "type-change";
}

export interface AvailableWorktreeInspection {
    status: "available";
    registered: true;
    headCommit: string;
    dirty: boolean;
    commitsAhead: number;
    hasWork: boolean;
    changedFiles: readonly WorktreeChangedFile[];
    omittedChangedFiles: number;
    untrackedFiles: readonly string[];
}

export interface UnavailableWorktreeInspection {
    status: "unavailable";
    registered: boolean;
    hasWork: true;
    changedFiles: readonly [];
    issue: string;
}

export type WorktreeInspection =
    | AvailableWorktreeInspection
    | UnavailableWorktreeInspection;

export interface AgentWorktreeSnapshot {
    path: string;
    branch: string;
    baseCommit: string;
    state: WorktreeState;
    sourceHadChanges: boolean;
    changedFiles: readonly WorktreeChangedFile[];
    omittedChangedFiles?: number;
    headCommit?: string;
    dirty?: boolean;
    commitsAhead?: number;
    revision?: string;
    cleanupReason?: WorktreeCleanupReason;
    issue?: string;
}

export interface AgentWorktreeRecord {
    version: 2;
    taskId: string;
    sessionId: string;
    sourceCwd: string;
    sourceGitRoot: string;
    mainGitRoot: string;
    path: string;
    branch: string;
    baseCommit: string;
    sourceHadChanges: boolean;
    createdAt: string;
    state: WorktreeState;
    cleanupReason?: WorktreeCleanupReason;
    issue?: string;
}

export interface WorktreeDiff {
    revision: string;
    stat: string;
    patch: string;
}

export interface WorktreeLifecycleResult {
    record: AgentWorktreeRecord;
    inspection?: WorktreeInspection;
}

export interface WorktreeRuntimeLike {
    create(input: {
        taskId: string;
        sessionId: string;
        signal: AbortSignal;
    }): Promise<AgentWorktreeRecord>;

    load(
        taskId: string,
        sessionId: string
    ): Promise<AgentWorktreeRecord | undefined>;

    createAgentContext(
        parentContext: ToolContext,
        record: AgentWorktreeRecord
    ): Promise<ToolContext>;

    inspect(record: AgentWorktreeRecord): Promise<WorktreeInspection>;

    finish(record: AgentWorktreeRecord): Promise<WorktreeLifecycleResult>;

    readDiff(
        record: AgentWorktreeRecord,
        inspection: AvailableWorktreeInspection
    ): Promise<WorktreeDiff>;

    discard(record: AgentWorktreeRecord): Promise<WorktreeLifecycleResult>;
}
