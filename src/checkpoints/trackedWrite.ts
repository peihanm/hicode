import type {CheckpointCoverageWarning, FileCheckpointRuntimeLike,} from "./types.js";
import {prepareFileCommit, type FileCommitCoordinator} from "./fileCommit.js";

export async function runTrackedFileWrite(input: {
    runtime: FileCheckpointRuntimeLike;
    coordinator: FileCommitCoordinator;
    signal: AbortSignal;
    path: string;
    beforeContent: string | Buffer | null;
    afterContent: string | Buffer | null;
    toolCallId: string;
}): Promise<{warnings: CheckpointCoverageWarning[]; identity?: string}> {
    return input.coordinator.run(input.path, input.signal, async canonical => {
        const commit = prepareFileCommit(input.path, canonical, input.beforeContent);
        const warnings: CheckpointCoverageWarning[] = [];
        const before = await input.runtime.beforeWrite({
            path: input.path,
            content: input.beforeContent,
            afterContent: input.afterContent,
            toolCallId: input.toolCallId,
        });
        if (before.warning) warnings.push(before.warning);
        if (input.runtime.enabled && !before.captured) {
            throw new Error(`未能保存写入前的 Checkpoint，本次未写入: ${before.warning?.message ?? input.path}`);
        }

        let identity: string | undefined;
        try {
            identity = await commit(input.afterContent, input.signal);
        } catch (error) {
            if (before.captured) await input.runtime.cancelWrite({path: canonical, toolCallId: input.toolCallId});
            throw error;
        }

        if (before.captured) {
            try {
                const after = await input.runtime.afterWrite({
                    path: input.path,
                    content: input.afterContent,
                    toolCallId: input.toolCallId,
                });
                if (after.warning) warnings.push({...after.warning, message: `文件已写入，回退记录未完成；不要重复该编辑。${after.warning.message}`});
            } catch (error) {
                warnings.push({
                    code: "checkpoint_after_write_failed",
                    path: input.path,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return {warnings, ...(identity ? {identity} : {})};
    });
}

export function formatCheckpointWarnings(
    warnings: readonly CheckpointCoverageWarning[]
): string {
    if (warnings.length === 0) return "";
    const detail = warnings
        .map((warning) => warning.path
            ? `${warning.path}: ${warning.message}`
            : warning.message)
        .join("；");
    return `\nCheckpoint 警告：${detail}`;
}
