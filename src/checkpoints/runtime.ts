import type {FileStateTracker} from "../tools/shared/fileState.js";
import {randomUUID} from "node:crypto";
import {createFileCheckpointStore, FileCheckpointStore} from "./store.js";
import type {
    BeginCheckpointInput,
    CaptureAfterWriteInput,
    CaptureBeforeWriteInput,
    CaptureResult,
    CheckpointCoverageWarning,
    CheckpointHead,
    CheckpointRestorePlan,
    CheckpointRestoreResult,
    FileCheckpointRecord,
    FileCheckpointRuntimeLike,
} from "./types.js";

function failureWarning(
    code: "checkpoint_write_failed" | "checkpoint_after_write_failed",
    error: unknown,
    path?: string
): CheckpointCoverageWarning {
    return {
        code,
        message: error instanceof Error ? error.message : String(error),
        ...(path ? {path} : {}),
    };
}

export class FileCheckpointRuntime implements FileCheckpointRuntimeLike {
    readonly enabled = true;
    private activeCheckpointId: string | undefined;
    private head: CheckpointHead;

    constructor(
        private readonly store: FileCheckpointStore,
        private readonly fileState?: FileStateTracker,
        initialHead?: CheckpointHead
    ) {
        this.head = initialHead ?? {branchId: randomUUID()};
    }

    async beginTurn(input: BeginCheckpointInput): Promise<FileCheckpointRecord> {
        const checkpoint = await this.store.beginCheckpoint({
            ...input,
            branchId: input.branchId ?? this.head.branchId,
            parentCheckpointId:
                input.parentCheckpointId ?? this.head.checkpointId,
        });
        this.activeCheckpointId = checkpoint.checkpointId;
        this.head = {
            branchId: checkpoint.branchId,
            checkpointId: checkpoint.checkpointId,
        };
        return checkpoint;
    }

    async settleTurn(
        status: FileCheckpointRecord["status"] = "settled"
    ): Promise<void> {
        const checkpointId = this.activeCheckpointId;
        this.activeCheckpointId = undefined;
        if (!checkpointId) return;
        await this.store.settleCheckpoint(checkpointId, status);
    }

    async beforeWrite(input: CaptureBeforeWriteInput): Promise<CaptureResult> {
        const checkpointId = this.activeCheckpointId;
        if (!checkpointId) {
            return {
                captured: false,
                warning: {
                    code: "checkpoint_write_failed",
                    message: "当前没有活动 File Checkpoint",
                    path: input.path,
                },
            };
        }
        try {
            await this.store.captureBefore(checkpointId, input);
            return {captured: true};
        } catch (error) {
            const warning = failureWarning(
                "checkpoint_write_failed",
                error,
                input.path
            );
            await this.store.addWarning(checkpointId, warning).catch(() => undefined);
            return {captured: false, warning};
        }
    }

    async afterWrite(input: CaptureAfterWriteInput): Promise<CaptureResult> {
        const checkpointId = this.activeCheckpointId;
        if (!checkpointId) {
            return {
                captured: false,
                warning: {
                    code: "checkpoint_after_write_failed",
                    message: "当前没有活动 File Checkpoint",
                    path: input.path,
                },
            };
        }
        try {
            await this.store.captureAfter(checkpointId, input);
            return {captured: true};
        } catch (error) {
            const warning = failureWarning(
                "checkpoint_after_write_failed",
                error,
                input.path
            );
            await this.store.addWarning(checkpointId, warning).catch(() => undefined);
            return {captured: false, warning};
        }
    }

    async markCoverageWarning(warning: CheckpointCoverageWarning): Promise<void> {
        if (!this.activeCheckpointId) return;
        await this.store
            .addWarning(this.activeCheckpointId, warning)
            .catch(() => undefined);
    }

    async listCheckpoints(): Promise<FileCheckpointRecord[]> {
        this.head = await this.store.getHead();
        return this.store.listCheckpoints();
    }

    previewRestore(checkpointId: string): Promise<CheckpointRestorePlan> {
        return this.store.previewRestore(checkpointId);
    }

    async restoreCode(checkpointId: string): Promise<CheckpointRestoreResult> {
        const result = await this.store.restoreCode(checkpointId);
        if (result.status === "complete") {
            this.head = await this.store.getHead();
            this.fileState?.clear();
        }
        return result;
    }

    getHead(): CheckpointHead {
        return {...this.head};
    }

}

class DisabledFileCheckpointRuntime implements FileCheckpointRuntimeLike {
    readonly enabled = false;

    constructor(
        private head: CheckpointHead,
        private readonly store?: FileCheckpointStore,
        private readonly fileState?: FileStateTracker
    ) {
    }

    async beginTurn(): Promise<null> {
        return null;
    }

    async settleTurn(): Promise<void> {
    }

    async beforeWrite(): Promise<CaptureResult> {
        return {captured: false};
    }

    async afterWrite(): Promise<CaptureResult> {
        return {captured: false};
    }

    async markCoverageWarning(): Promise<void> {
    }

    async listCheckpoints(): Promise<FileCheckpointRecord[]> {
        if (!this.store) return [];
        this.head = await this.store.getHead();
        return this.store.listCheckpoints();
    }

    async previewRestore(checkpointId: string): Promise<CheckpointRestorePlan> {
        if (!this.store) {
            throw new Error(`File Checkpoint 已关闭，无法预览 ${checkpointId}`);
        }
        return this.store.previewRestore(checkpointId);
    }

    async restoreCode(checkpointId: string): Promise<CheckpointRestoreResult> {
        if (!this.store) {
            throw new Error(`File Checkpoint 已关闭，无法恢复 ${checkpointId}`);
        }
        const result = await this.store.restoreCode(checkpointId);
        if (result.status === "complete") {
            this.head = await this.store.getHead();
            this.fileState?.clear();
        }
        return result;
    }

    getHead(): CheckpointHead {
        return {...this.head};
    }

}

export function createFileCheckpointRuntime(input: {
    cwd: string;
    sessionId: string;
    enabled: boolean;
    fileState?: FileStateTracker;
    initialHead?: CheckpointHead;
}): FileCheckpointRuntimeLike {
    const head = input.initialHead ?? {branchId: randomUUID()};
    const store = createFileCheckpointStore(input.cwd, input.sessionId);
    if (!input.enabled) {
        return new DisabledFileCheckpointRuntime(head, store, input.fileState);
    }
    return new FileCheckpointRuntime(
        store,
        input.fileState,
        head
    );
}

export function createDisabledFileCheckpointRuntime(
    initialHead: CheckpointHead = {branchId: "disabled"}
): FileCheckpointRuntimeLike {
    return new DisabledFileCheckpointRuntime(initialHead);
}
