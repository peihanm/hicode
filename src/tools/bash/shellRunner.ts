import {normalizeTurnAbortReason} from "../../runtime/abort.js";
import type {NetworkAccessExecution} from "../../permissions/networkAccess.js";
import {mergeChildProcessEnvironment, type ChildProcessEnvironment,} from "../../runtime/childEnvironment.js";
import type {SandboxExecutionPreference, SandboxRuntimeLike, SandboxStatus,} from "../../sandbox/index.js";
import {runShellArgv, runShellCommand, type ShellCommandOptions, type ShellExecutionResult,} from "./process.js";

interface ShellRunnerRequest extends ShellCommandOptions {
    sandboxPermissions?: SandboxExecutionPreference;
    writableRoots?: readonly string[];
    networkAccess?: NetworkAccessExecution;
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
                `Sandbox preparation failed: ${error instanceof Error ? error.message : String(error)}`
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
                writableRoots,
                networkAccess,
                command,
                env,
                ...processOptions
            } = request;
            if (
                sandboxPermissions === "require_escalated"
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
                    request.signal,
                    {writableRoots, networkAccess}
                );
            } catch (error) {
                return sandboxFailure(request.signal, error);
            }

            try {
                const commandEnvironment = mergeChildProcessEnvironment(childEnvironment, wrapped.env, env);
                if (wrapped.env.npm_config_cache !== undefined) {
                    // npm accepts case-insensitive config names. Remove inherited aliases so
                    // a parent npm run cannot silently restore an unwritable user cache.
                    for (const name of Object.keys(commandEnvironment)) {
                        if (name.toLowerCase() === "npm_config_cache") delete commandEnvironment[name];
                    }
                    Object.assign(commandEnvironment, mergeChildProcessEnvironment(
                        {base: {}, excludedNames: childEnvironment.excludedNames},
                        {npm_config_cache: wrapped.env.npm_config_cache}
                    ));
                }
                const result = await runShellArgv({
                    argv: wrapped.argv,
                    env: commandEnvironment,
                    ...processOptions,
                });
                let stderr = result.stderr;
                try {
                    stderr = sandbox.annotateStderr(command, stderr);
                } catch {
                }
                if (wrapped.networkDenials?.length) {
                    stderr += `\nHiCode Sandbox: network proxy denied ${wrapped.networkDenials.join(";")}.` +
                        "This is a local network permission restriction, not a remote service failure. Do not change sources or escalate to bypass a user denial.";
                }
                return {...result, stderr};
            } finally {
                wrapped.release?.();
                try {
                    sandbox.cleanupAfterCommand();
                } catch {
                }
            }
        },
    };
}
