import {isatty} from "node:tty";
import {writeSync} from "node:fs";

/** The CLI waits for UI-owned resource cleanup, including initialization that finishes after unmount. */
export class InteractiveShutdown {
    private readonly controller = new AbortController();
    readonly signal = this.controller.signal;
    private readonly pending = new Set<() => Promise<void>>();
    private closing: Promise<void> | undefined;

    register(cleanup: () => Promise<void>): () => void {
        let operation: Promise<void> | undefined;
        const run = () => {
            if (!operation) {
                operation = (async () => {await cleanup();})();
                void operation.then(() => this.pending.delete(run), () => this.pending.delete(run));
            }
            return operation;
        };
        this.pending.add(run);
        if (this.signal.aborted) void run().catch(() => {});
        return () => {void run().catch(() => {});};
    }

    close(): Promise<void> {
        this.controller.abort("shutdown");
        this.closing ??= (async () => {
            while (this.pending.size) await Promise.allSettled([...this.pending].map(run => run()));
        })();
        return this.closing;
    }
}

export function bindInteractiveSignals(shutdown: InteractiveShutdown, onExit: () => void): () => void {
    let requested = false;
    const stdinWasTTY = process.stdin.isTTY === true;
    const stdoutWasTTY = process.stdout.isTTY === true;
    const terminalProbe = Buffer.alloc(0);
    let terminalCheck: ReturnType<typeof setInterval> | undefined;
    const stopChecking = () => clearInterval(terminalCheck);
    const stop = (code: number) => {
        if (requested) return;
        requested = true;
        stopChecking();
        process.exitCode = code;
        void shutdown.close();
        onExit();
    };
    const sigint = () => stop(130);
    const sigterm = () => stop(143);
    const terminalLost = () => {if (!shutdown.signal.aborted) stop(129);};
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
    if (process.platform !== "win32") process.on("SIGHUP", terminalLost);

    // A revoked PTY may not deliver SIGHUP or update the stream's cached isTTY flag.
    // Observe only descriptors that were terminals at startup; redirected streams are valid.
    if (stdinWasTTY) {
        process.stdin.on("end", terminalLost);
        process.stdin.on("close", terminalLost);
        process.stdin.on("error", terminalLost);
    }
    if (stdoutWasTTY) {
        process.stdout.on("close", terminalLost);
        process.stdout.on("error", terminalLost);
    }
    if (stdinWasTTY || stdoutWasTTY) {
        terminalCheck = setInterval(() => {
            if ((stdinWasTTY && (!process.stdin.readable || !isatty(process.stdin.fd))) ||
                (stdoutWasTTY && (!process.stdout.writable || !isatty(process.stdout.fd)))) {
                terminalLost();
                return;
            }
            // macOS can retain isatty=true after the PTY master closes. A zero-byte
            // write detects EIO even before Ink starts reading, without rendering output.
            if (stdoutWasTTY) {
                try {writeSync(process.stdout.fd, terminalProbe);}
                catch (error) {
                    if (error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
                        ["EIO", "EBADF", "ENXIO", "EPIPE"].includes(error.code)) terminalLost();
                }
            }
        }, 1_000);
        terminalCheck.unref();
    }
    shutdown.signal.addEventListener("abort", stopChecking, {once: true});
    if (shutdown.signal.aborted) stopChecking();
    return () => {
        stopChecking();
        shutdown.signal.removeEventListener("abort", stopChecking);
        process.removeListener("SIGINT", sigint);
        process.removeListener("SIGTERM", sigterm);
        if (process.platform !== "win32") process.removeListener("SIGHUP", terminalLost);
        if (stdinWasTTY) {
            process.stdin.removeListener("end", terminalLost);
            process.stdin.removeListener("close", terminalLost);
            process.stdin.removeListener("error", terminalLost);
        }
        if (stdoutWasTTY) {
            process.stdout.removeListener("close", terminalLost);
            process.stdout.removeListener("error", terminalLost);
        }
    };
}
