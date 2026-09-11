import type {DiffHunk} from "../fileChanges/index.js";

export type GitOperationState =
    | "normal"
    | "merge"
    | "rebase"
    | "cherry-pick"
    | "revert";

export type GitFileChangeKind =
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "type-changed"
    | "untracked"
    | "conflicted";

export type GitStatusCode = "M" | "T" | "A" | "D" | "R" | "C" | "U";

export interface GitFileStatus {
    path: string;
    originalPath?: string;
    kind: GitFileChangeKind;
    indexStatus: GitStatusCode | null;
    worktreeStatus: GitStatusCode | null;
    staged: boolean;
    unstaged: boolean;
    submodule: string | null;
}

export interface GitNumstatEntry {
    path: string;
    originalPath?: string;
    additions: number | null;
    deletions: number | null;
    binary: boolean;
}

type GitDiffUnavailableReason =
    | "binary"
    | "conflict"
    | "missing"
    | "symlink"
    | "unsupported-file"
    | "parse-error";

export interface GitDiffFile {
    status: GitFileStatus;
    additions: number | null;
    deletions: number | null;
    binary: boolean;
    hunks: readonly DiffHunk[];
    diffStatus: "complete" | "truncated" | "unavailable";
    omittedDiffLines?: number;
    unavailableReason?: GitDiffUnavailableReason;
}

interface GitDiffSnapshot {
    version: 1;
    repository: GitRepositorySnapshot;
    files: readonly GitDiffFile[];
    patch: string;
    truncated: boolean;
    omittedFiles: number;
}

export type GitDiffSnapshotResult =
    | {status: "available"; snapshot: GitDiffSnapshot}
    | {
        status: "unavailable";
        reason: GitRepositoryUnavailableReason;
        message: string;
    };


export interface GitRepositorySnapshot {
    version: 1;
    repositoryIdentity: string;
    repositoryRoot: string;
    branch: string | null;
    headOid: string | null;
    detached: boolean;
    unborn: boolean;
    operation: GitOperationState;
    clean: boolean;
    files: readonly GitFileStatus[];
    recentCommitTitles: readonly string[];
}

export type GitRepositoryUnavailableReason =
    | "not-git-repository"
    | "git-unavailable"
    | "cancelled"
    | "command-failed";

export type GitRepositoryRootResult =
    | {status: "available"; repositoryRoot: string}
    | {
        status: "unavailable";
        reason: GitRepositoryUnavailableReason;
        message: string;
    };

export type GitRepositorySnapshotResult =
    | {status: "available"; snapshot: GitRepositorySnapshot}
    | {
        status: "unavailable";
        reason: GitRepositoryUnavailableReason;
        message: string;
    };


export interface ParsedGitStatus {
    branch: string | null;
    headOid: string | null;
    detached: boolean;
    unborn: boolean;
    files: readonly GitFileStatus[];
}
