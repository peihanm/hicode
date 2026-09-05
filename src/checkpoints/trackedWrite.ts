import type {CheckpointCoverageWarning, FileCheckpointRuntimeLike,} from "./types.js";
import {prepareFileCommit, type FileCommitCoordinator} from "./fileCommit.js";

export async function runTrackedFileWrite(input: {
    runtime: FileCheckpointRuntimeLike;
    coordinator: FileCommitCoordinator;
    signal: AbortSignal;
    path: string;
    beforeContent: string | null;
    afterContent: string | null;
    toolCallId: string;
}): Promise<CheckpointCoverageWarning[]> {
    return input.coordinator.run(input.path, input.signal, async canonical => {
        const commit = prepareFileCommit(input.path, canonical, input.beforeContent);
        const warnings: CheckpointCoverageWarning[] = [];
        const before = await input.runtime.beforeWrite({
            path: input.path,
            content: input.beforeContent,
            toolCallId: input.toolCallId,
        });
        if (before.warning) warnings.push(before.warning);

        await commit(input.afterContent, input.signal);

        if (before.captured) {
            try {
                const after = await input.runtime.afterWrite({
                    path: input.path,
                    content: input.afterContent,
                    toolCallId: input.toolCallId,
                });
                if (after.warning) warnings.push(after.warning);
            } catch (error) {
                warnings.push({
                    code: "checkpoint_after_write_failed",
                    path: input.path,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return warnings;
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
