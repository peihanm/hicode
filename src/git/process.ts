import {type ChildProcess, spawn} from "node:child_process";
import {
    type ChildProcessEnvironment,
    mergeChildProcessEnvironment,
} from "../runtime/childEnvironment.js";
import {createProcessTreeKiller} from "../tools/bash/process.js";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const killProcessTree = createProcessTreeKiller();

export type GitProcessTermination =
    | {kind: "exit"; code: number; signal: NodeJS.Signals | null}
    | {kind: "aborted"}
    | {kind: "timeout"; timeoutMs: number}
    | {kind: "output-limit"; maxOutputBytes: number}
    | {kind: "spawn-error"; error: Error};

interface GitProcessResult {
    code: number;
    stdout: Buffer;
    stderr: Buffer;
    termination: GitProcessTermination;
}

interface GitProcessOptions {
    timeoutMs?: number;
    maxOutputBytes?: number;
    input?: Buffer;
}

export interface GitCommandRunner {
    (
        cwd: string,
        args: readonly string[],
        signal?: AbortSignal,
        options?: GitProcessOptions
    ): Promise<GitProcessResult>;
}

function resultCode(termination: GitProcessTermination): number {
    switch (termination.kind) {
        case "exit":
            return termination.code;
        case "timeout":
            return 124;
        case "output-limit":
            return 125;
        case "spawn-error":
            return 126;
        case "aborted":
            return 130;
    }
}

function terminationMessage(termination: GitProcessTermination): string {
    switch (termination.kind) {
        case "exit":
            return `exit code ${termination.code}`;
        case "aborted":
            return "Git operation cancelled";
        case "timeout":
            return `Git operation exceeded ${termination.timeoutMs}ms`;
        case "output-limit":
            return `Git output exceeded ${termination.maxOutputBytes} byte limit`;
        case "spawn-error":
            return termination.error.message;
    }
}

export function formatGitProcessError(result: GitProcessResult): string {
    const stderr = result.stderr.toString("utf8").trim();
    const stdout = result.stdout.toString("utf8").trim();
    if (result.termination.kind !== "exit") {
        const message = terminationMessage(result.termination);
        const detail = stderr || stdout;
        return detail && detail !== message ? `${message}:${detail}` : message;
    }
    return stderr || stdout || terminationMessage(result.termination);
}

function runGitCommand(
    environment: ChildProcessEnvironment,
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
    options: GitProcessOptions = {}
): Promise<GitProcessResult> {
    const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES;
    if (signal?.aborted) {
        const termination: GitProcessTermination = {kind: "aborted"};
        return Promise.resolve({
            code: resultCode(termination),
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(terminationMessage(termination)),
            termination,
        });
    }

    return new Promise((resolve) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        let forcedTermination: Exclude<GitProcessTermination, {kind: "exit"}> | undefined;
        let killFallback: ReturnType<typeof setTimeout> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let child: ChildProcess;

        const finish = (termination: GitProcessTermination) => {
            if (settled) return;
            settled = true;
            if (timeout !== undefined) clearTimeout(timeout);
            if (killFallback !== undefined) clearTimeout(killFallback);
            signal?.removeEventListener("abort", onAbort);
            child.stdout?.removeAllListeners("data");
            child.stderr?.removeAllListeners("data");
            child.removeAllListeners("error");
            child.removeAllListeners("close");
            resolve({
                code: resultCode(termination),
                stdout: Buffer.concat(stdout),
                stderr: Buffer.concat(stderr),
                termination,
            });
        };

        const terminate = (
            termination: Exclude<GitProcessTermination, {kind: "exit"}>
        ) => {
            if (settled || forcedTermination) return;
            forcedTermination = termination;
            void killProcessTree(child);
            killFallback = setTimeout(() => finish(termination), 1_000);
            killFallback.unref?.();
        };

        const onAbort = () => terminate({kind: "aborted"});

        const append = (target: Buffer[], chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = Math.max(0, maxOutputBytes - outputBytes);
            if (remaining > 0) target.push(buffer.subarray(0, remaining));
            outputBytes += buffer.length;
            if (outputBytes > maxOutputBytes) {
                terminate({
                    kind: "output-limit",
                    maxOutputBytes,
                });
            }
        };

        try {
            child = spawn("git", ["-C", cwd, ...args], {
                shell: false,
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
                env: mergeChildProcessEnvironment(environment, {
                    GIT_TERMINAL_PROMPT: "0",
                    GIT_ASKPASS: "",
                    GCM_INTERACTIVE: "Never",
                    GIT_PAGER: "cat",
                    PAGER: "cat",
                    LC_ALL: "C",
                }),
            });
        } catch (error) {
            const termination: GitProcessTermination = {
                kind: "spawn-error",
                error: error instanceof Error ? error : new Error(String(error)),
            };
            return resolve({
                code: resultCode(termination),
                stdout: Buffer.alloc(0),
                stderr: Buffer.from(termination.error.message),
                termination,
            });
        }

        child.stdout?.on("data", (chunk) => append(stdout, chunk));
        child.stderr?.on("data", (chunk) => append(stderr, chunk));
        child.once("error", (error) => finish({kind: "spawn-error", error}));
        child.once("close", (code, closeSignal) => finish(
            forcedTermination ?? {
                kind: "exit",
                code: code ?? 1,
                signal: closeSignal,
            }
        ));
        child.stdin?.on("error", error => terminate({kind: "spawn-error", error}));
        if (options.input) child.stdin?.end(options.input);
        signal?.addEventListener("abort", onAbort, {once: true});
        if (signal?.aborted) onAbort();

        timeout = setTimeout(
            () => terminate({kind: "timeout", timeoutMs}),
            timeoutMs
        );
        timeout.unref?.();
    });
}

/** Bind Git execution to the Root-owned, secret-filtered child environment. */
export function createGitCommandRunner(
    environment: ChildProcessEnvironment
): GitCommandRunner {
    return (cwd, args, signal, options) =>
        runGitCommand(environment, cwd, args, signal, options);
}
