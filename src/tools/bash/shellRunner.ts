import {normalizeTurnAbortReason} from "../../runtime/abort.js";
import {prepareReadCommand} from "./readCommand.js";
import type {CommandReadAccess} from "./readAccess.js";
import type {NetworkAccessExecution} from "../../permissions/networkAccess.js";
import {mergeChildProcessEnvironment, type ChildProcessEnvironment,} from "../../runtime/childEnvironment.js";
import type {SandboxExecutionPreference, SandboxRuntimeLike, SandboxStatus,} from "../../sandbox/index.js";
import {runShellArgv, runShellCommand, type ShellCommandOptions, type ShellExecutionResult,} from "./process.js";

interface ShellRunnerRequest extends ShellCommandOptions {
    sandboxPermissions?: SandboxExecutionPreference;
    writableRoots?: readonly string[];
    networkAccess?: NetworkAccessExecution;
    readAccess?: CommandReadAccess;
    fileWorkspace?: {root: string; writable: boolean};
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
                readAccess,
                fileWorkspace,
                command,
                env,
                ...processOptions
            } = request;
            if ((readAccess || fileWorkspace) && sandboxPermissions === "require_escalated") {
                return sandboxFailure(request.signal, new Error("Read-only command execution cannot leave the Sandbox"));
            }
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
                const prepared = readAccess ? await prepareReadCommand(readAccess, request.cwd, childEnvironment) : undefined;
                wrapped = await sandbox.wrapCommand(
                    prepared?.command ?? command,
                    request.cwd,
                    request.signal,
                    prepared ? {readOnlyAccess: prepared.access} : {writableRoots, networkAccess, fileWorkspace}
                );
            } catch (error) {
                return sandboxFailure(request.signal, error);
            }

            try {
                const commandEnvironment = readAccess || fileWorkspace
                    ? {PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TERM: "dumb"}
                    : mergeChildProcessEnvironment(childEnvironment, wrapped.env, env);
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
                    if (stderr !== result.stderr && !readAccess) {
                        stderr += "\nHiCode Sandbox reported a policy violation. Check the denied operation and any partial effects before retrying. If this necessary operation requires leaving the sandbox and has not been explicitly denied, request sandbox_permissions=require_escalated; this result itself grants no extra access.";
                    }
                } catch {
                }
                if (wrapped.networkDenials?.length) {
                    stderr += `\nHiCode Sandbox: network proxy denied ${wrapped.networkDenials.join(";")}.` +
                        " This is a local network permission restriction, not a remote service failure. Follow the reason above; changing registry or offline/peer-dependency flags cannot grant network access. Do not bypass an explicit denial. The command may have partially executed; it was not automatically retried.";
                }
                return {...result, stderr};
            } finally {
                wrapped.release?.();
                try {
                    // Scoped file commands build their own argv, not an ASRT command lease.
                    // Decrementing ASRT's Linux mount counter here can release a concurrent
                    // ordinary command's deny mounts before that command has finished.
                    if (!readAccess && !fileWorkspace) sandbox.cleanupAfterCommand();
                } catch {
                }
            }
        },
    };
}
