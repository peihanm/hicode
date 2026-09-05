import type {InteractionResponse} from "./protocol.js";

export function normalizeInteractionResponse(value: unknown): InteractionResponse {
    if (typeof value !== "object" || value === null || !("behavior" in value)) {
        return {
            behavior: "deny",
            message: "SDK Host 返回了无效 interaction response",
        };
    }
    if (value.behavior === "allow") {
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
        if (networkScope !== undefined && (directoryScope !== undefined || persistence === "always")) {
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
            ...("updatedInput" in value
                ? {updatedInput: value.updatedInput}
                : {}),
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

export function raceInteractionWithAbort<T>(
    operation: Promise<T>,
    signal: AbortSignal
): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(new Error("操作已取消"));
    }
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            cleanup();
            reject(new Error("操作已取消"));
        };
        const cleanup = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, {once: true});
        operation.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error: unknown) => {
                cleanup();
                reject(error);
            }
        );
    });
}
