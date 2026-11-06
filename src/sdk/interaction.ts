import {randomUUID} from "node:crypto";
import type {PermissionDecision} from "../permissions/index.js";
import type {ToolContextHost} from "../runtime/toolContext.js";
import type {SDKEventAdapter} from "./eventAdapter.js";
import type {HiCodeHost, HostDiagnostic, InteractionContext} from "./types.js";
import {validUserAnswer} from "../runtime/userQuestions.js";
import type {InteractionRequest, InteractionResponse} from "./protocol.js";

export function normalizeInteractionResponse(value: unknown): InteractionResponse {
    if (typeof value !== "object" || value === null || !("behavior" in value)) {
        return {
            behavior: "deny",
            message: "SDK Host returned an invalid interaction response",
        };
    }
    if (value.behavior === "allow") {
        if (Object.keys(value).some(key => !["behavior", "persistence", "directoryScope", "networkScope", "answers"].includes(key))) {
            return {behavior: "deny", message: "SDK Host returned unknown interaction response fields"};
        }
        const rawAnswers = "answers" in value ? value.answers : undefined;
        let answers: Record<string, string | string[]> | undefined;
        if (rawAnswers !== undefined) {
            if (typeof rawAnswers !== "object" || rawAnswers === null || Array.isArray(rawAnswers)) {
                return {behavior: "deny", message: "SDK Host returned invalid answers"};
            }
            const entries = Object.entries(rawAnswers);
            if (entries.length < 1 || entries.length > 4 || entries.some(([key, answer]) =>
                !key.trim() || !validUserAnswer(answer))) {
                return {behavior: "deny", message: "SDK Host returned invalid answers"};
            }
            answers = {};
            for (const [key, answer] of entries) {
                if (validUserAnswer(answer)) Object.defineProperty(answers, key, {value: answer, enumerable: true});
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
                message: "SDK Host returned invalid persistence",
            };
        }
        const directoryScope = "directoryScope" in value
            ? value.directoryScope
            : undefined;
        const networkScope = "networkScope" in value ? value.networkScope : undefined;
        if (networkScope !== undefined && networkScope !== "once" && networkScope !== "session") {
            return {behavior: "deny", message: "SDK Host returned invalid networkScope"};
        }
        if (networkScope !== undefined && (directoryScope !== undefined || persistence === "always" || answers !== undefined)) {
            return {behavior: "deny", message: "Network grants cannot be combined with directory or permanent grants"};
        }
        if (
            directoryScope !== undefined &&
            directoryScope !== "once" &&
            directoryScope !== "session" &&
            directoryScope !== "project"
        ) {
            return {
                behavior: "deny",
                message: "SDK Host returned invalid directoryScope",
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
        message: "SDK Host returned an invalid interaction response",
    };
}

export async function raceInteractionWithAbort<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal
): Promise<T> {
    if (signal.aborted) throw new Error("Operation cancelled");
    const request = new AbortController();
    const abort = () => request.abort(signal.reason);
    signal.addEventListener("abort", abort, {once: true});
    let rejectAbort: (() => void) | undefined;
    try {
        const interrupted = new Promise<never>((_, reject) => {
            rejectAbort = () => reject(new Error("Operation cancelled"));
            request.signal.addEventListener("abort", rejectAbort, {once: true});
        });
        const result = await Promise.race([interrupted, Promise.resolve().then(() => {
            if (request.signal.aborted) throw new Error("Operation cancelled");
            return operation(request.signal);
        })]);
        if (signal.aborted) throw new Error("Operation cancelled");
        return result;
    } finally {
        signal.removeEventListener("abort", abort);
        if (rejectAbort) request.signal.removeEventListener("abort", rejectAbort);
        request.abort("interaction-ended");
    }
}

export async function reportHostDiagnostic(host: HiCodeHost | undefined, diagnostic: HostDiagnostic): Promise<void> {
    try {
        await host?.onDiagnostic?.(diagnostic);
    } catch {
        // Host diagnostics cannot disrupt runtime lifecycle or approval decisions.
    }
}

export async function requestHostInteraction(
    host: HiCodeHost | undefined,
    request: InteractionRequest,
    context: InteractionContext
): Promise<InteractionResponse> {
    const callback = host?.onInteraction;
    if (!callback) return {behavior: "deny", message: "SDK Host did not provide onInteraction; interaction-required operation denied"};
    try {
        return normalizeInteractionResponse(await raceInteractionWithAbort(
            signal => callback(request, {...context, signal}), context.signal
        ));
    } catch (error) {
        const message = context.signal.aborted ? "Interaction cancelled"
            : `SDK Host interaction failed: ${error instanceof Error ? error.message : String(error)}`;
        if (!context.signal.aborted) await reportHostDiagnostic(host, {severity: "warning", scope: "runtime", message});
        return {behavior: "deny", message};
    }
}

interface InteractionProjection {
    turnId: string;
    adapter?: Pick<SDKEventAdapter, "emitInteractionStart" | "emitInteractionEnd">;
}

export function createToolInteractionHandler(context: {
    host: HiCodeHost | undefined;
    cwd: string;
    threadId: string;
    projection: InteractionProjection;
    ownerSignal: AbortSignal;
    isClosed(): boolean;
    getProjection(): InteractionProjection | undefined;
}): ToolContextHost["canUseTool"] {
    return async (toolName, message, input, options) => {
        if (context.isClosed()) return {behavior: "deny", message: "SDK Thread is closed"};
        const network = options?.presentation?.kind === "network_access"
            ? options.presentation : undefined;
        const asyncQuestion = toolName === "ask_user" && options?.questionDelivery === "async";
        // Child Tasks own their requests independently of the originating Root Turn.
        if (options?.actor && !options.signal) return {behavior: "deny", message: "Child permission request has no cancellation signal"};
        const projection = options?.actor ? context.getProjection() : context.projection;
        const signal = (options?.actor || asyncQuestion) && options?.signal ? options.signal : options?.signal
            ? AbortSignal.any([context.ownerSignal, options.signal])
            : context.ownerSignal;
        const request: InteractionRequest = toolName === "ask_user"
            ? {
                requestId: randomUUID(),
                ...(options?.actor ? {actor: options.actor} : {}),
                kind: "question",
                delivery: asyncQuestion ? "async" : "sync",
                toolName,
                message,
                input,
            }
            : {
                requestId: randomUUID(),
                ...(options?.actor ? {actor: options.actor} : {}),
                kind: "permission",
                toolName,
                message,
                input,
                ...(network ? {networkAccess: {host: network.host, port: network.port}} : {}),
            };
        if (!asyncQuestion) await projection?.adapter?.emitInteractionStart(request);
        let response = await requestHostInteraction(context.host, request, {
            cwd: context.cwd, threadId: context.threadId, turnId: projection?.turnId, signal,
        });
        if (context.isClosed()) response = {behavior: "deny", message: "SDK Thread is closed"};
        if (network && response.behavior === "allow" && (
            response.persistence === "always" || response.directoryScope !== undefined ||
            response.answers !== undefined
        )) {
            response = {behavior: "deny", message: "Network connections do not support permanent tool grants, directory grants or input changes"};
        }
        const status = signal.aborted
            ? "interrupted"
            : response.behavior === "deny"
                ? "denied"
                : "completed";
        if (!asyncQuestion && (!options?.actor || context.getProjection() === projection)) {
            await projection?.adapter?.emitInteractionEnd(request, response, status);
        }
        return toPermissionDecision(response);
    };
}

function toPermissionDecision(
    response: InteractionResponse
): PermissionDecision {
    return response.behavior === "allow"
        ? {
            behavior: "allow",
            ...(response.networkScope === undefined ? {} : {networkScope: response.networkScope}),
            ...(response.directoryScope === undefined
                ? {}
                : {directoryScope: response.directoryScope}),
            ...(response.answers === undefined
                ? {}
                : {answers: response.answers}),
        }
        : {behavior: "deny", message: response.message};
}
