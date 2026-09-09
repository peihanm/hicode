import {Worker} from "node:worker_threads";
import {normalizeTurnAbortReason, throwIfTurnAborted, TurnInterruptedError} from "../../runtime/abort.js";
import type {SearchRequest, SearchResponse} from "./protocol.js";

/** One worker per tool invocation, reused sequentially for its authorized files. */
export function createGrepMatcher(signal: AbortSignal) {
    throwIfTurnAborted(signal);
    // Bun runs TypeScript source; the Node SDK ships this separately bundled worker asset.
    const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./grep.worker.js", import.meta.url));
    let closing: Promise<number> | undefined;
    let failure: Error | undefined;
    let pending: {resolve(result: SearchResponse): void; reject(error: Error): void} | undefined;
    const stop = (error: Error) => {
        failure ??= error;
        pending?.reject(failure);
        pending = undefined;
        closing ??= worker.terminate();
    };
    const onAbort = () => stop(new TurnInterruptedError(normalizeTurnAbortReason(signal.reason)));
    const onError = (error: Error) => stop(error);
    const onExit = (code: number) => {
        if (!closing) stop(new Error(`Grep 搜索进程提前退出（${code}），未完成扫描`));
    };
    const onMessage = (result: SearchResponse) => {
        pending?.resolve(result);
        pending = undefined;
    };
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.on("message", onMessage);
    signal.addEventListener("abort", onAbort, {once: true});
    if (signal.aborted) onAbort();
    return {
        async search(input: SearchRequest, remainingMs: number): Promise<SearchResponse> {
            throwIfTurnAborted(signal);
            if (failure) throw failure;
            if (closing || pending) throw new Error("Grep worker 当前不可接受搜索");
            const timeout = setTimeout(() => stop(new Error("Grep 搜索超时，未完成扫描；请缩小范围或简化正则")), Math.max(1, Math.min(5_000, remainingMs)));
            try {
                return await new Promise<SearchResponse>((resolve, reject) => {
                    pending = {resolve, reject};
                    worker.postMessage(input);
                });
            } finally { clearTimeout(timeout); }
        },
        async close(): Promise<void> {
            signal.removeEventListener("abort", onAbort);
            stop(new Error("Grep worker 已关闭"));
            await closing;
            worker.removeListener("error", onError);
            worker.removeListener("exit", onExit);
            worker.removeListener("message", onMessage);
        },
    };
}
