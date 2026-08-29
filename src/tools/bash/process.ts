import {type ChildProcess, spawn, type SpawnOptions,} from "node:child_process";
import {closeSync, openSync, writeSync} from "node:fs";
import {normalizeTurnAbortReason, type TurnAbortReason,} from "../../runtime/abort.js";

export type ShellTermination =
    | { kind: "exit"; code: number; signal: NodeJS.Signals | null }
    | { kind: "aborted"; reason: TurnAbortReason }
    | { kind: "timeout"; timeoutMs: number }
    | { kind: "output_limit"; maxBuffer: number }
    | { kind: "spawn_error"; error: Error };

export interface ShellExecutionResult {
    stdout: string;
    stderr: string;
    termination: ShellTermination;
    outputFilePath?: string;
    outputBytes?: number;
    outputComplete?: boolean;
}

export interface ShellCommandOptions {
    command: string;
    cwd: string;
    signal: AbortSignal;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number | null;
    maxBuffer?: number;
    outputFilePath?: string;
    maxOutputBytes?: number;
    previewChars?: number;
}

export interface ShellArgvOptions extends Omit<ShellCommandOptions, "command"> {
    argv: string[];
}

type ProcessLaunch =
    | {kind: "shell"; command: string}
    | {kind: "argv"; argv: string[]};

interface ProcessTreeKillerDependencies {
    platform: NodeJS.Platform;
    spawnProcess: typeof spawn;
    taskkillTimeoutMs: number;
}

export function createProcessTreeKiller(
    overrides: Partial<ProcessTreeKillerDependencies> = {}
) {
    const platform = overrides.platform ?? process.platform;
    const spawnProcess = overrides.spawnProcess ?? spawn;
    const taskkillTimeoutMs = overrides.taskkillTimeoutMs ?? 1_000;

    return function killProcessTree(child: ChildProcess): Promise<void> {
        const pid = child.pid;
        if (!pid) return Promise.resolve();

        if (platform === "win32") {
            return new Promise((resolve) => {
                let completed = false;
                try {
                    const killer = spawnProcess(
                        "taskkill",
                        ["/pid", String(pid), "/T", "/F"],
                        {
                            stdio: "ignore",
                            windowsHide: true,
                        }
                    );
                    const finish = (fallback: boolean) => {
                        if (completed) return;
                        completed = true;
                        clearTimeout(timer);
                        if (fallback) {
                            try {
                                child.kill("SIGKILL");
                            } catch {
                            }
                        }
                        resolve();
                    };
                    killer.once("error", () => finish(true));
                    killer.once("close", (code) => finish(code !== 0));
                    const timer = setTimeout(() => {
                        try {
                            killer.kill("SIGKILL");
                        } catch {
                        }
                        finish(true);
                    }, taskkillTimeoutMs);
                } catch {
                    try {
                        child.kill("SIGKILL");
                    } catch {
                    }
                    resolve();
                }
            });
        }

        try {
            // detached=true 为命令创建独立 process group；负 pid 终止整个组。
            process.kill(-pid, "SIGKILL");
        } catch {
            try {
                child.kill("SIGKILL");
            } catch {
            }
        }
        return Promise.resolve();
    };
}

const killProcessTree = createProcessTreeKiller();

export function runShellCommand(options: ShellCommandOptions): Promise<ShellExecutionResult> {
    const {command, ...rest} = options;
    return runProcess({
        ...rest,
        launch: {kind: "shell", command},
    });
}

export function runShellArgv(options: ShellArgvOptions): Promise<ShellExecutionResult> {
    const {argv, ...rest} = options;
    return runProcess({
        ...rest,
        launch: {kind: "argv", argv},
    });
}

function runProcess({
                        launch,
                        cwd,
                        signal,
                        stdin,
                        env,
                        timeoutMs = 30_000,
                        maxBuffer = 1024 * 1024,
                        outputFilePath,
                        maxOutputBytes = 64 * 1024 * 1024,
                        previewChars = 30_000,
                    }: Omit<ShellCommandOptions, "command"> & {
    launch: ProcessLaunch;
}): Promise<ShellExecutionResult> {
    if (signal.aborted) {
        return Promise.resolve({
            stdout: "",
            stderr: "",
            termination: {
                kind: "aborted",
                reason: normalizeTurnAbortReason(signal.reason),
            },
        });
    }

    return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let forcedTermination: Exclude<ShellTermination, { kind: "exit" }> | undefined;
        let killFallback: ReturnType<typeof setTimeout> | undefined;
        let outputBytes = 0;
        let bufferedBytes = 0;
        let outputWrittenBytes = 0;
        let outputComplete = true;
        let outputFd: number | undefined;

        if (outputFilePath) {
            try {
                outputFd = openSync(outputFilePath, "a", 0o600);
            } catch (error) {
                return resolve({
                    stdout: "",
                    stderr: "",
                    termination: {
                        kind: "spawn_error",
                        error: error instanceof Error ? error : new Error(String(error)),
                    },
                });
            }
        }

        let child: ChildProcess;
        try {
            const spawnOptions: SpawnOptions = {
                cwd,
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: [
                    stdin === undefined ? "ignore" : "pipe",
                    "pipe",
                    "pipe",
                ],
                ...(env ? {env} : {}),
            };
            if (launch.kind === "shell") {
                child = spawn(launch.command, {
                    ...spawnOptions,
                    shell: true,
                });
            } else {
                const [program, ...args] = launch.argv;
                if (!program) throw new Error("命令 argv 不能为空");
                child = spawn(program, args, {
                    ...spawnOptions,
                    shell: false,
                });
            }
        } catch (error) {
            if (outputFd !== undefined) {
                try {
                    closeSync(outputFd);
                } catch {
                }
            }
            return resolve({
                stdout: "",
                stderr: "",
                termination: {
                    kind: "spawn_error",
                    error: error instanceof Error ? error : new Error(String(error)),
                },
                ...(outputFilePath
                    ? {outputFilePath, outputBytes, outputComplete: false}
                    : {}),
            });
        }

        let timeout: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
            if (timeout !== undefined) clearTimeout(timeout);
            if (killFallback !== undefined) clearTimeout(killFallback);
            signal.removeEventListener("abort", onAbort);
            child.stdout?.removeAllListeners("data");
            child.stderr?.removeAllListeners("data");
            child.stdin?.removeAllListeners("error");
            child.removeAllListeners("error");
            child.removeAllListeners("close");
            if (outputFd !== undefined) {
                try {
                    closeSync(outputFd);
                } catch {
                }
                outputFd = undefined;
            }
        };

        const finish = (termination: ShellTermination) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                stdout,
                stderr,
                termination,
                ...(outputFilePath ? {outputFilePath, outputBytes, outputComplete} : {}),
            });
        };

        const terminate = (
            termination: Exclude<ShellTermination, { kind: "exit" }>
        ) => {
            if (settled || forcedTermination) return;
            forcedTermination = termination;
            void killProcessTree(child);
            // 极端情况下子进程不发 close，也要保证取消路径有界结束。
            killFallback = setTimeout(() => finish(termination), 1_000);
            killFallback.unref?.();
        };

        const onAbort = () =>
            terminate({
                kind: "aborted",
                reason: normalizeTurnAbortReason(signal.reason),
            });

        const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const text = buffer.toString("utf8");
            if (outputFd !== undefined) {
                outputBytes += buffer.length;
                if (target === "stdout") {
                    if (stdout.length < previewChars) stdout += text.slice(0, previewChars - stdout.length);
                } else if (stderr.length < previewChars) {
                    stderr += text.slice(0, previewChars - stderr.length);
                }
                const remaining = Math.max(0, maxOutputBytes - outputWrittenBytes);
                if (remaining > 0) {
                    const writable = buffer.subarray(0, remaining);
                    try {
                        writeSync(outputFd, writable);
                        outputWrittenBytes += writable.length;
                    } catch (error) {
                        outputComplete = false;
                        terminate({
                            kind: "spawn_error",
                            error: error instanceof Error ? error : new Error(String(error)),
                        });
                        return;
                    }
                }
                if (buffer.length > remaining) {
                    outputComplete = false;
                    terminate({kind: "output_limit", maxBuffer: maxOutputBytes});
                }
            } else {
                bufferedBytes += buffer.length;
                if (target === "stdout") stdout += text;
                else stderr += text;
                if (bufferedBytes > maxBuffer) {
                    terminate({kind: "output_limit", maxBuffer});
                }
            }
        };

        child.stdout?.on("data", (chunk) => append("stdout", chunk));
        child.stderr?.on("data", (chunk) => append("stderr", chunk));
        if (stdin !== undefined) {
            // Hook 等短命令可能在父进程写完前退出；忽略 EPIPE，由 close/exit
            // 统一表达命令结果，避免产生未处理的 stream error。
            child.stdin?.on("error", () => undefined);
            child.stdin?.end(stdin, "utf8");
        }
        child.once("error", (error) =>
            finish({kind: "spawn_error", error})
        );
        child.once("close", (code, closeSignal) => {
            finish(
                forcedTermination ?? {
                    kind: "exit",
                    code: code ?? 1,
                    signal: closeSignal,
                }
            );
        });
        signal.addEventListener("abort", onAbort, {once: true});

        if (timeoutMs !== null) {
            timeout = setTimeout(
                () => terminate({kind: "timeout", timeoutMs}),
                timeoutMs
            );
            timeout.unref?.();
        }
    });
}
