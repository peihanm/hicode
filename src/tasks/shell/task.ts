import {noMatchSearch, shellOutcome} from "../../tools/bash/result.js";
import {createTurnAbortController, normalizeTurnAbortReason} from "../../runtime/abort.js";
import type {ShellRunnerLike} from "../../tools/bash/shellRunner.js";
import type {StartShellTaskInput, TaskSessionBinding, TaskStatus,} from "../types.js";
import type {ManagedShellTask} from "../managed.js";
import {readOutputPreview} from "./output.js";
import {isExpectedShellShutdown} from "../notifications.js";

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function createShellTask(
    id: string,
    binding: TaskSessionBinding,
    input: StartShellTaskInput
): Promise<ManagedShellTask> {
    const outputPath = await binding.toolResultStore.createCapture();
    return {
        kind: "shell",
        id,
        phase: "queued",
        createdTick: performance.now(),
        published: false,
        publication: Promise.resolve(),
        executionMode: input.sandboxPermissions === "require_escalated" ? "host" : "sandbox",
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
    execution: {onPhaseChanged(): void},
    onFinished: (task: ManagedShellTask) => Promise<void>
): Promise<void> {
    let finalStatus: TaskStatus = "failed";
    try {
        const run = () => {
            task.phase = "starting";
            task.acquiredTick = performance.now();
            execution.onPhaseChanged();
            return shellRunner.run({
                command: input.command,
                cwd: input.cwd,
                signal: task.controller.signal,
                timeoutMs: null,
                outputFilePath: task.outputPath,
                maxOutputBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
                previewChars: 30_000,
                onStarted: () => {task.phase = "running"; task.processStartedAt = new Date().toISOString(); task.processStartedTick = performance.now(); execution.onPhaseChanged();},
                sandboxPermissions: input.sandboxPermissions,
                writableRoots: input.writableRoots,
                deniedReadRoots: input.deniedReadRoots,
                networkAccess: input.networkAccess,
            });
        };
        const result = await run();
        if (!task.published) task.inlineResult = result;
        const outcome = shellOutcome(input.command, result);
        finalStatus = outcome === "ok" ? "completed" : outcome === "interrupted" ? "cancelled" : "failed";
        task.termination = result.termination;
        const outputPreview = await readOutputPreview(task.outputPath);
        const noMatches = noMatchSearch(input.command, result);
        task.outputPreview = noMatches ? `No matches found (${noMatches} exit code 1).` : outputPreview;
        // Proxy approval diagnostics are generated after process output capture.
        if (result.stderr.trim() && !task.outputPreview.includes(result.stderr.trim())) {
            task.outputPreview = `${task.outputPreview}\n${result.stderr}`.trim();
        }
        if (task.published || (result.outputBytes ?? 0) > 30_000 || result.outputComplete === false) try {
            task.outputResult = await task.store.promoteFile({
                toolCallId: task.owner.toolCallId,
                toolName: "task",
                sourcePath: task.outputPath,
                originalByteLength: result.outputBytes,
                complete: result.outputComplete,
                resultId: `task_${task.id}`,
            });
        } catch (error) {
            task.outputIssue = error instanceof Error
                ? error.message
                : String(error);
            finalStatus = "failed";
        }
    } catch (error) {
        finalStatus = task.controller.signal.aborted ? "cancelled" : "failed";
        task.outputIssue = error instanceof Error ? error.message : String(error);
        if (!task.published) task.inlineResult = {stdout: "", stderr: "", termination: task.controller.signal.aborted
            ? {kind: "aborted", reason: normalizeTurnAbortReason(task.controller.signal.reason)}
            : {kind: "spawn_error", error: error instanceof Error ? error : new Error(String(error))}};
    } finally {
        task.status = finalStatus;
        task.phase = "finished";
        task.finishedTick = performance.now();
        task.completedAt = new Date().toISOString();
        task.notificationPending = !task.suppressTerminalNotification && !isExpectedShellShutdown(task);
        await task.store.removeTemporaryFile(task.outputPath);
        await onFinished(task);
    }
}
