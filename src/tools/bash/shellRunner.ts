import {normalizeTurnAbortReason} from "../../runtime/abort.js";
import {mergeChildProcessEnvironment, type ChildProcessEnvironment,} from "../../runtime/childEnvironment.js";
import type {SandboxExecutionPreference, SandboxRuntimeLike, SandboxStatus,} from "../../sandbox/index.js";
import {runShellArgv, runShellCommand, type ShellCommandOptions, type ShellExecutionResult,} from "./process.js";

interface ShellRunnerRequest extends ShellCommandOptions {
    sandboxPermissions?: SandboxExecutionPreference;
}

export interface ShellRunnerLike {
    readonly sandboxStatus: SandboxStatus;

    run(request: ShellRunnerRequest): Promise<ShellExecutionResult>;
}

function sandboxFailure(
    signal: AbortSignal,
    error: unknown
): ShellExecutionResult {
    if (signal.aborted) {
        return {
            stdout: "",
            stderr: "",
            termination: {
                kind: "aborted",
                reason: normalizeTurnAbortReason(signal.reason),
            },
        };
    }
    return {
        stdout: "",
        stderr: "",
        termination: {
            kind: "spawn_error",
            error: new Error(
                `Sandbox 准备失败: ${error instanceof Error ? error.message : String(error)}`
            ),
        },
    };
}

export function createShellRunner(
    sandbox: SandboxRuntimeLike,
    childEnvironment: ChildProcessEnvironment
): ShellRunnerLike {
    return {
        get sandboxStatus() {
            return sandbox.status;
        },
        async run(request) {
            const {
                sandboxPermissions = "use_default",
                command,
                env,
                ...processOptions
            } = request;
            if (
                sandboxPermissions === "require_escalated" ||
                sandbox.status.kind === "disabled"
            ) {
                return runShellCommand({
                    command,
                    env: mergeChildProcessEnvironment(childEnvironment, env),
                    ...processOptions,
                });
            }
            if (sandbox.status.kind === "unavailable") {
                return sandboxFailure(
                    request.signal,
                    new Error(sandbox.status.reason)
                );
            }

            let wrapped;
            try {
                wrapped = await sandbox.wrapCommand(
                    command,
                    request.cwd,
                    request.signal
                );
            } catch (error) {
                return sandboxFailure(request.signal, error);
            }

            try {
                const result = await runShellArgv({
                    argv: wrapped.argv,
                    env: mergeChildProcessEnvironment(
                        childEnvironment,
                        wrapped.env,
                        env
                    ),
                    ...processOptions,
                });
                let stderr = result.stderr;
                try {
                    stderr = sandbox.annotateStderr(command, stderr);
                } catch {
                }
                return {...result, stderr};
            } finally {
                try {
                    sandbox.cleanupAfterCommand();
                } catch {
                }
            }
        },
    };
}
