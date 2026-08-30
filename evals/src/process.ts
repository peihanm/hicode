import {mkdir} from "node:fs/promises";
import type {EvalProcessResult} from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

interface RunProcessOptions {
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    maxOutputBytes?: number;
}

interface BoundedText {
    text: string;
    truncated: boolean;
}

export async function createVerifierEnvironment(
    verifierHome: string
): Promise<Record<string, string>> {
    await mkdir(verifierHome, {recursive: true});
    const env: Record<string, string> = {
        HOME: verifierHome,
        CI: "1",
        NO_COLOR: "1",
    };
    for (const key of [
        "PATH",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "SHELL",
    ]) {
        const value = process.env[key];
        if (value) env[key] = value;
    }
    return env;
}

export async function runProcess(
    argv: readonly string[],
    options: RunProcessOptions
): Promise<EvalProcessResult> {
    const startedAt = performance.now();
    let processHandle: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
        processHandle = Bun.spawn([...argv], {
            cwd: options.cwd,
            env: options.env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
    } catch (error) {
        return {
            argv: [...argv],
            exitCode: 126,
            stdout: "",
            stderr: "",
            durationMs: Math.round(performance.now() - startedAt),
            timedOut: false,
            outputTruncated: false,
            spawnError: error instanceof Error ? error.message : String(error),
        };
    }

    let timedOut = false;
    let killFallback: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
        timedOut = true;
        processHandle.kill("SIGTERM");
        killFallback = setTimeout(() => processHandle.kill("SIGKILL"), 1_000);
        killFallback.unref?.();
    }, options.timeoutMs);
    timeout.unref?.();

    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        readBoundedText(processHandle.stdout, maxOutputBytes),
        readBoundedText(processHandle.stderr, maxOutputBytes),
    ]);
    clearTimeout(timeout);
    if (killFallback !== undefined) clearTimeout(killFallback);
    return {
        argv: [...argv],
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Math.round(performance.now() - startedAt),
        timedOut,
        outputTruncated: stdout.truncated || stderr.truncated,
    };
}

async function readBoundedText(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number
): Promise<BoundedText> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let retainedBytes = 0;
    let totalBytes = 0;
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        const remaining = Math.max(0, maxBytes - retainedBytes);
        if (remaining > 0) {
            const retained = value.subarray(0, remaining);
            chunks.push(retained);
            retainedBytes += retained.byteLength;
        }
    }
    const merged = new Uint8Array(retainedBytes);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return {
        text: new TextDecoder().decode(merged),
        truncated: totalBytes > retainedBytes,
    };
}
