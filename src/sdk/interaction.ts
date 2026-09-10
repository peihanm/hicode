import type {InteractionResponse} from "./protocol.js";

export function normalizeInteractionResponse(value: unknown): InteractionResponse {
    if (typeof value !== "object" || value === null || !("behavior" in value)) {
        return {
            behavior: "deny",
            message: "SDK Host 返回了无效 interaction response",
        };
    }
    if (value.behavior === "allow") {
        if (Object.keys(value).some(key => !["behavior", "persistence", "directoryScope", "networkScope", "answers"].includes(key))) {
            return {behavior: "deny", message: "SDK Host 返回了未知 interaction response 字段"};
        }
        const rawAnswers = "answers" in value ? value.answers : undefined;
        let answers: Record<string, string> | undefined;
        if (rawAnswers !== undefined) {
            if (typeof rawAnswers !== "object" || rawAnswers === null || Array.isArray(rawAnswers)) {
                return {behavior: "deny", message: "SDK Host 返回了无效 answers"};
            }
            const entries = Object.entries(rawAnswers);
            if (entries.length < 1 || entries.length > 4 || entries.some(([key, answer]) =>
                !key.trim() || typeof answer !== "string" || !answer.trim() || answer.length > 16_384)) {
                return {behavior: "deny", message: "SDK Host 返回了无效 answers"};
            }
            answers = {};
            for (const [key, answer] of entries) {
                if (typeof answer === "string") Object.defineProperty(answers, key, {value: answer, enumerable: true});
            }
        }
        const persistence = "persistence" in value
            ? value.persistence
            : undefined;
        if (
            persistence !== undefined &&
            persistence !== "once" &&
            persistence !== "always"
        ) {
            return {
                behavior: "deny",
                message: "SDK Host 返回了无效 persistence",
            };
        }
        const directoryScope = "directoryScope" in value
            ? value.directoryScope
            : undefined;
        const networkScope = "networkScope" in value ? value.networkScope : undefined;
        if (networkScope !== undefined && networkScope !== "once" && networkScope !== "session") {
            return {behavior: "deny", message: "SDK Host 返回了无效 networkScope"};
        }
        if (networkScope !== undefined && (directoryScope !== undefined || persistence === "always" || answers !== undefined)) {
            return {behavior: "deny", message: "网络授权不能混用目录或永久授权"};
        }
        if (
            directoryScope !== undefined &&
            directoryScope !== "once" &&
            directoryScope !== "session" &&
            directoryScope !== "project"
        ) {
            return {
                behavior: "deny",
                message: "SDK Host 返回了无效 directoryScope",
            };
        }
        return {
            behavior: "allow",
            ...(persistence === undefined ? {} : {persistence}),
            ...(directoryScope === undefined ? {} : {directoryScope}),
            ...(networkScope === undefined ? {} : {networkScope}),
            ...(answers === undefined ? {} : {answers}),
        };
    }
    if (
        value.behavior === "deny" &&
        "message" in value &&
        typeof value.message === "string"
    ) {
        return {behavior: "deny", message: value.message.slice(0, 1_000)};
    }
    return {
        behavior: "deny",
        message: "SDK Host 返回了无效 interaction response",
    };
}

export async function raceInteractionWithAbort<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal
): Promise<T> {
    if (signal.aborted) throw new Error("操作已取消");
    const request = new AbortController();
    const abort = () => request.abort(signal.reason);
    signal.addEventListener("abort", abort, {once: true});
    let rejectAbort: (() => void) | undefined;
    try {
        const interrupted = new Promise<never>((_, reject) => {
            rejectAbort = () => reject(new Error("操作已取消"));
            request.signal.addEventListener("abort", rejectAbort, {once: true});
        });
        const result = await Promise.race([interrupted, Promise.resolve().then(() => {
            if (request.signal.aborted) throw new Error("操作已取消");
            return operation(request.signal);
        })]);
        if (signal.aborted) throw new Error("操作已取消");
        return result;
    } finally {
        signal.removeEventListener("abort", abort);
        if (rejectAbort) request.signal.removeEventListener("abort", rejectAbort);
        request.abort("interaction-ended");
    }
}
