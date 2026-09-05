import {runShellArgv, runShellCommand,} from "../tools/bash/process.js";
import {hookJSONOutputSchema} from "./schema.js";
import {boundedHookMessage, type HookHandlerResult} from "./handler.js";
import type {HookExecution, HookInput, HookSettings,} from "./types.js";

const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;

interface HookCommandRunResult {
    stdout: string;
    stderr: string;
    termination:
        | {kind: "exit"; code: number}
        | {kind: "aborted"}
        | {kind: "timeout"; timeoutMs: number}
        | {kind: "output_limit"; maxBuffer: number}
        | {kind: "spawn_error"; message: string};
}

interface ExecuteHookCommandInput {
    command: string;
    shell?: "bash" | "powershell";
    cwd: string;
    stdin: string;
    signal: AbortSignal;
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
}

export type ExecuteHookCommand = (
    input: ExecuteHookCommandInput
) => Promise<HookCommandRunResult>;

export async function defaultExecuteHookCommand(
    input: ExecuteHookCommandInput
): Promise<HookCommandRunResult> {
    const processOptions = {
        cwd: input.cwd,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        maxBuffer: MAX_HOOK_OUTPUT_BYTES,
        stdin: input.stdin,
        env: input.environment,
    };
    const result = input.shell === "powershell"
        ? await runShellArgv({
            ...processOptions,
            argv: [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                input.command,
            ],
        })
        : await runShellCommand({
            ...processOptions,
            command: input.command,
        });
    const termination = result.termination;
    if (termination.kind === "exit") {
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            termination: {kind: "exit", code: termination.code},
        };
    }
    if (termination.kind === "aborted") {
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            termination: {kind: "aborted"},
        };
    }
    if (termination.kind === "timeout" || termination.kind === "output_limit") {
        return {stdout: result.stdout, stderr: result.stderr, termination};
    }
    return {
        stdout: result.stdout,
        stderr: result.stderr,
        termination: {
            kind: "spawn_error",
            message: termination.error.message,
        },
    };
}

export async function executeCommandHook({
    event,
    source,
    hook,
    cwd,
    input,
    signal,
    executeCommand,
    environment,
}: {
    event: HookInput["hook_event_name"];
    source: HookExecution["source"];
    hook: Extract<HookSettings, {type: "command"}>;
    cwd: string;
    input: HookInput;
    signal: AbortSignal;
    executeCommand: ExecuteHookCommand;
    environment: NodeJS.ProcessEnv;
}): Promise<HookHandlerResult> {
    const startedAt = Date.now();
    const identity = {
        event,
        source,
        type: "command" as const,
        handler: hook.command,
        commandInvoked: true as const,
    };
    let run: HookCommandRunResult;
    try {
        run = await executeCommand({
            command: hook.command,
            shell: hook.shell,
            cwd,
            stdin: `${JSON.stringify({version: 1, cwd, ...input})}\n`,
            signal,
            timeoutMs: hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
            environment,
        });
    } catch (error) {
        return {
            execution: {
                ...identity,
                outcome: "error",
                durationMs: Date.now() - startedAt,
                message: boundedHookMessage(
                    `Hook 启动失败: ${error instanceof Error ? error.message : String(error)}`
                ),
            },
        };
    }
    const base = {...identity, durationMs: Date.now() - startedAt};
    if (run.termination.kind === "aborted") {
        return {
            execution: {
                ...base,
                outcome: "interrupted",
                message: "Hook 执行已取消",
            },
            interrupted: true,
        };
    }
    if (run.termination.kind === "timeout") {
        return {
            execution: {
                ...base,
                outcome: "error",
                message: `Hook 超时 (${run.termination.timeoutMs}ms)`,
            },
        };
    }
    if (run.termination.kind === "output_limit") {
        return {
            execution: {
                ...base,
                outcome: "error",
                message: `Hook 输出超过上限 (${run.termination.maxBuffer} bytes)`,
            },
        };
    }
    if (run.termination.kind === "spawn_error") {
        return {
            execution: {
                ...base,
                outcome: "error",
                message: boundedHookMessage(
                    `Hook 启动失败: ${run.termination.message}`
                ),
            },
        };
    }
    const exitCode = run.termination.code;
    if (exitCode === 2) {
        const reason = boundedHookMessage(
            (run.stderr || run.stdout).trim() || "Hook 阻止了操作"
        );
        return {
            execution: {
                ...base,
                outcome: "blocking",
                exitCode,
                message: reason,
            },
            output: {decision: "block", reason},
        };
    }
    if (exitCode !== 0) {
        return {
            execution: {
                ...base,
                outcome: "error",
                exitCode,
                message: boundedHookMessage(
                    run.stderr.trim() || `Hook 退出码 ${exitCode}`
                ),
            },
        };
    }
    const stdout = run.stdout.trim();
    if (!stdout) {
        return {
            execution: {...base, outcome: "success", exitCode},
        };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(stdout);
    } catch {
        return {
            execution: {
                ...base,
                outcome: "error",
                exitCode,
                message: "Hook stdout 不是合法 JSON",
            },
        };
    }
    const parsed = hookJSONOutputSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            execution: {
                ...base,
                outcome: "error",
                exitCode,
                message: boundedHookMessage(
                    `Hook JSON 输出校验失败: ${parsed.error.issues[0]?.message ?? "未知错误"}`
                ),
            },
        };
    }
    return {
        execution: {
            ...base,
            outcome: parsed.data.decision === "block" ? "blocking" : "success",
            exitCode,
            ...(parsed.data.reason ? {message: parsed.data.reason} : {}),
        },
        output: parsed.data,
    };
}
