import {rewindSessionCheckpoint} from "./rewind.js";
import type {CheckpointRestoreResult} from "./types.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";

function formatTextResult(result: CheckpointRestoreResult): string {
    const lines = [
        `Rewind ${result.status}: ${result.checkpointId}`,
        result.status === "complete"
            ? `代码与对话恢复完成；恢复 ${result.restoredFiles.length} 个文件，删除 ${result.deletedFiles.length} 个新建文件。`
            : `恢复未完整完成；已恢复 ${result.restoredFiles.length} 个文件，删除 ${result.deletedFiles.length} 个新建文件。`,
    ];
    for (const conflict of result.conflicts) {
        lines.push(`冲突: ${conflict.path} · ${conflict.message}`);
    }
    for (const failure of result.failures) {
        lines.push(`失败: ${failure.path} · ${failure.message}`);
    }
    for (const warning of result.coverageWarnings) {
        lines.push(`警告: ${warning.path ? `${warning.path} · ` : ""}${warning.message}`);
    }
    return `${lines.join("\n")}\n`;
}

export async function runCheckpointRewindFromCli(input: {
    storage: PillarStorageLayout;
    cwd: string;
    model: string;
    sessionId: string;
    checkpointId: string;
    outputFormat: "text" | "json";
    childEnvironment: ChildProcessEnvironment;
}): Promise<void> {
    try {
        const result = await rewindSessionCheckpoint(input);
        process.stdout.write(
            input.outputFormat === "json"
                ? `${JSON.stringify(result)}\n`
                : formatTextResult(result)
        );
        process.exitCode = result.status === "complete" ? 0 : 2;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (input.outputFormat === "json") {
            process.stdout.write(`${JSON.stringify({status: "error", error: message})}\n`);
        } else {
            process.stderr.write(`Rewind 失败: ${message}\n`);
        }
        process.exitCode = 1;
    }
}
