import {setMaxListeners} from "node:events";

export type TurnAbortReason =
    | "user-cancel"
    | "sigint"
    | "timeout"
    | "shutdown";

const TURN_ABORT_REASONS = new Set<TurnAbortReason>([
    "user-cancel",
    "sigint",
    "timeout",
    "shutdown",
]);

export class TurnInterruptedError extends Error {
    readonly reason: TurnAbortReason;

    constructor(reason: TurnAbortReason, message = "任务已中断") {
        super(message);
        this.name = "TurnInterruptedError";
        this.reason = reason;
    }
}

export function createTurnAbortController(): AbortController {
    const controller = new AbortController();
    setMaxListeners(50, controller.signal);
    return controller;
}

export function normalizeTurnAbortReason(
    reason: unknown,
    fallback: TurnAbortReason = "shutdown"
): TurnAbortReason {
    if (typeof reason === "string" && TURN_ABORT_REASONS.has(reason as TurnAbortReason)) {
        return reason as TurnAbortReason;
    }
    if (reason instanceof TurnInterruptedError) return reason.reason;
    return fallback;
}

export function throwIfTurnAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    throw new TurnInterruptedError(normalizeTurnAbortReason(signal.reason));
}

export function isTurnInterruptedError(
    error: unknown,
    parentSignal?: AbortSignal
): error is TurnInterruptedError {
    if (error instanceof TurnInterruptedError) return true;
    return Boolean(parentSignal?.aborted);
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    throwIfTurnAborted(signal);
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        timer.unref?.();

        const onAbort = () => {
            cleanup();
            reject(new TurnInterruptedError(normalizeTurnAbortReason(signal.reason)));
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
        };
        signal.addEventListener("abort", onAbort, {once: true});
    });
}
