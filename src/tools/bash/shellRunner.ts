import {normalizeTurnAbortReason} from "../../runtime/abort.js";
import type {NetworkAccessExecution} from "../../permissions/networkAccess.js";
import {mergeChildProcessEnvironment, type ChildProcessEnvironment,} from "../../runtime/childEnvironment.js";
import type {SandboxExecutionPreference, SandboxRuntimeLike, SandboxStatus,} from "../../sandbox/index.js";
import type {SandboxCommandOptions} from "../../sandbox/types.js";
import {runShellArgv, runShellCommand, type ShellCommandOptions, type ShellExecutionResult,} from "./process.js";

interface ShellRunnerRequest extends ShellCommandOptions {
    sandboxPermissions?: SandboxExecutionPreference;
    writableRoots?: readonly string[];
    networkAccess?: NetworkAccessExecution;
    filesystemScope?: SandboxCommandOptions["filesystemScope"];
}

const LOCAL_BINDING_HINT =
    'Pillar Sandbox: 本地端口监听被 OS Sandbox 阻止。请使用完全相同的命令并设置 sandbox_permissions="require_escalated" 重试；不要换端口或重写服务。';
const LOCAL_CONNECTION_HINT =
    'Pillar Sandbox: 本地端点访问被 OS Sandbox 阻止。请使用完全相同的探测命令并设置 sandbox_permissions="require_escalated" 重试。';

export function annotateSandboxLocalNetworkFailure(output: string): string {
    if (!output || output.includes("Pillar Sandbox:")) return output;
    const bindingDenied =
        /\blisten\s+EPERM\b/i.test(output) ||
        /(?:server_bind|socket\.bind|http\.server)[\s\S]*PermissionError:\s*\[Errno\s+1\]\s+Operation not permitted/i.test(output);
    const connectionDenied =
        /(?:Immediate connect fail for|Failed to connect to)\s+(?:127\.0\.0\.1|localhost|\[::1\])[\s\S]*(?:Operation not permitted|Couldn't connect)/i.test(output);
    const hint = bindingDenied
        ? LOCAL_BINDING_HINT
        : connectionDenied
            ? LOCAL_CONNECTION_HINT
            : undefined;
    return hint ? `${output.trimEnd()}\n\n${hint}` : output;
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
                writableRoots,
                networkAccess,
                filesystemScope,
                command,
                env,
                ...processOptions
            } = request;
            if (filesystemScope && (sandboxPermissions === "require_escalated" || sandbox.status.kind !== "ready")) {
                return sandboxFailure(request.signal, new Error("Shell 快照写边界要求活动 OS Sandbox"));
            }
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
                    request.signal,
                    {writableRoots, networkAccess, filesystemScope}
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
                stderr = annotateSandboxLocalNetworkFailure(stderr);
                if (wrapped.networkDenials?.length) {
                    stderr += `\nPillar Sandbox: 网络代理拒绝 ${wrapped.networkDenials.join("；")}。` +
                        "这是本地网络权限限制，不代表远端服务故障；用户拒绝后不要自动换源或提权绕过。";
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
