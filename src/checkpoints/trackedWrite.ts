import type {CheckpointCoverageWarning, FileCheckpointRuntimeLike,} from "./types.js";

export async function runTrackedFileWrite(input: {
    runtime: FileCheckpointRuntimeLike;
    path: string;
    beforeContent: string | null;
    afterContent: string | null;
    toolCallId: string;
    write(): Promise<void>;
}): Promise<CheckpointCoverageWarning[]> {
    const warnings: CheckpointCoverageWarning[] = [];
    const before = await input.runtime.beforeWrite({
        path: input.path,
        content: input.beforeContent,
        toolCallId: input.toolCallId,
    });
    if (before.warning) warnings.push(before.warning);

    await input.write();

    if (before.captured) {
        const after = await input.runtime.afterWrite({
            path: input.path,
            content: input.afterContent,
            toolCallId: input.toolCallId,
        });
        if (after.warning) warnings.push(after.warning);
    }
    return warnings;
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
