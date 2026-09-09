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
    const stop = (code: number) => {
        if (requested) return;
        requested = true;
        process.exitCode = code;
        void shutdown.close();
        onExit();
    };
    const sigint = () => stop(130);
    const sigterm = () => stop(143);
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
    return () => {process.removeListener("SIGINT", sigint); process.removeListener("SIGTERM", sigterm);};
}
