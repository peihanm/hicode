import type {FileChange} from "../fileChanges/index.js";

export const CHECKPOINT_MANIFEST_VERSION = 3;

type CheckpointWarningCode =
    | "bash_side_effects"
    | "hook_side_effects"
    | "mcp_side_effects"
    | "host_tool_side_effects"
    | "unsupported_path"
    | "unsupported_file"
    | "file_too_large"
    | "checkpoint_write_failed"
    | "checkpoint_after_write_failed";

export interface CheckpointCoverageWarning {
    code: CheckpointWarningCode;
    message: string;
    path?: string;
}

export interface FileFingerprint {
    kind: "missing" | "regular";
    sha256?: string;
    byteLength?: number;
    mode?: number;
}

export interface CheckpointFileMutation {
    root: string;
    path: string;
    before: FileFingerprint;
    beforeBlobId?: string;
    after?: FileFingerprint;
    firstToolCallId: string;
    lastToolCallId: string;
}

export interface FileCheckpointRecord {
    version: 3;
    checkpointId: string;
    sessionId: string;
    branchId: string;
    parentCheckpointId?: string;
    sequence: number;
    createdAt: string;
    prompt: string;
    promptPreview: string;
    status: "active" | "settled" | "no_agent_run";
    fileCoverage: "complete" | "incomplete";
    coverageWarnings: CheckpointCoverageWarning[];
    mutations: CheckpointFileMutation[];
}

export interface FileCheckpointIndexEntry {
    checkpointId: string;
    parentCheckpointId?: string;
    sequence: number;
}

export interface CheckpointHead {
    branchId: string;
    checkpointId?: string;
}

export interface FileCheckpointManifest {
    version: 3;
    cwd: string;
    sessionId: string;
    sequence: number;
    head: CheckpointHead;
    checkpoints: FileCheckpointIndexEntry[];
}

type RestoreFileAction = "create" | "update" | "delete" | "noop";

interface CheckpointConflict {
    path: string;
    reason:
        | "external_change"
        | "missing_blob"
        | "corrupt_blob"
        | "incomplete_checkpoint"
        | "unsupported_path"
        | "unsupported_file";
    message: string;
}

export interface CheckpointRestoreFile {
    root: string;
    relativePath: string;
    path: string;
    action: RestoreFileAction;
    target: FileFingerprint;
    targetBlobId?: string;
    expectedCurrent: FileFingerprint;
    actualCurrent: FileFingerprint;
    change?: FileChange;
}

export interface CheckpointRestorePlan {
    checkpointId: string;
    files: CheckpointRestoreFile[];
    conflicts: CheckpointConflict[];
    coverageWarnings: CheckpointCoverageWarning[];
}

interface CheckpointRestoreFailure {
    path: string;
    message: string;
}

export interface CheckpointRestoreResult {
    status: "complete" | "conflict" | "partial" | "failed";
    checkpointId: string;
    restoredFiles: string[];
    deletedFiles: string[];
    conflicts: CheckpointConflict[];
    failures: CheckpointRestoreFailure[];
    coverageWarnings: CheckpointCoverageWarning[];
}

export interface BeginCheckpointInput {
    checkpointId?: string;
    prompt: string;
    branchId?: string;
    parentCheckpointId?: string;
}

export interface CaptureBeforeWriteInput {
    path: string;
    content: string | null;
    toolCallId: string;
}

export interface CaptureAfterWriteInput {
    path: string;
    content: string | null;
    toolCallId: string;
}

export interface CaptureResult {
    captured: boolean;
    warning?: CheckpointCoverageWarning;
}

export interface FileCheckpointRuntimeLike {
    readonly enabled: boolean;

    beginTurn(input: BeginCheckpointInput): Promise<FileCheckpointRecord | null>;

    settleTurn(status?: FileCheckpointRecord["status"]): Promise<void>;

    beforeWrite(input: CaptureBeforeWriteInput): Promise<CaptureResult>;

    afterWrite(input: CaptureAfterWriteInput): Promise<CaptureResult>;

    markCoverageWarning(warning: CheckpointCoverageWarning): Promise<void>;

    listCheckpoints(): Promise<FileCheckpointRecord[]>;

    previewRestore(checkpointId: string): Promise<CheckpointRestorePlan>;

    restoreCode(checkpointId: string): Promise<CheckpointRestoreResult>;

    getHead(): CheckpointHead;
}
