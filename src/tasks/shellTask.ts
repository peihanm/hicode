import {randomUUID} from "node:crypto";
import {createTurnAbortController} from "../runtime/abort.js";
import type {ShellExecutionResult} from "../tools/bash/process.js";
import type {ShellRunnerLike} from "../tools/bash/shellRunner.js";
import type {StartShellTaskInput, TaskSessionBinding, TaskStatus,} from "./types.js";
import {type ManagedShellTask, readOutputPreview,} from "./managed.js";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function statusFromResult(result: ShellExecutionResult): TaskStatus {
    if (result.termination.kind === "aborted") return "cancelled";
    return result.termination.kind === "exit" && result.termination.code === 0
        ? "completed"
        : "failed";
}

export async function createShellTask(
    binding: TaskSessionBinding,
    input: StartShellTaskInput
): Promise<ManagedShellTask> {
    const outputPath = await binding.toolResultStore.createCapture();
    return {
        id: randomUUID(),
        owner: {sessionId: binding.sessionId, toolCallId: input.toolCallId},
        command: input.command,
        cwd: input.cwd,
        status: "running",
        startedAt: new Date().toISOString(),
        outputPath,
        store: binding.toolResultStore,
        controller: createTurnAbortController(),
        notificationPending: false,
        suppressTerminalNotification: false,
        completion: Promise.resolve(),
    };
}

export async function runShellTask(
    task: ManagedShellTask,
    input: StartShellTaskInput,
    shellRunner: ShellRunnerLike,
    onFinished: (task: ManagedShellTask) => Promise<void>
): Promise<void> {
    let finalStatus: TaskStatus = "failed";
    try {
        const result = await shellRunner.run({
            command: input.command,
            cwd: input.cwd,
            signal: task.controller.signal,
            timeoutMs: null,
            outputFilePath: task.outputPath,
            maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
            previewChars: 0,
            sandboxPermissions: input.sandboxPermissions,
        });
        finalStatus = statusFromResult(result);
        task.termination = result.termination;
        task.outputPreview = await readOutputPreview(task.outputPath);
        try {
            task.outputResult = await task.store.promoteFile({
                toolCallId: task.owner.toolCallId,
                toolName: "bash_task",
                sourcePath: task.outputPath,
                originalByteLength: result.outputBytes,
                complete: result.outputComplete,
                resultId: `task_${task.id}`,
            });
        } catch (error) {
            task.outputIssue = error instanceof Error
                ? error.message
                : String(error);
        }
    } catch (error) {
        finalStatus = task.controller.signal.aborted ? "cancelled" : "failed";
        task.outputIssue = error instanceof Error ? error.message : String(error);
    } finally {
        task.status = finalStatus;
        task.completedAt = new Date().toISOString();
        task.notificationPending = !task.suppressTerminalNotification;
        await task.store.removeTemporaryFile(task.outputPath);
        await onFinished(task);
    }
}
