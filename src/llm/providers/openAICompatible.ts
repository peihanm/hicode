import {createHash, randomUUID} from "node:crypto";
import {encodeImageMessages, ImageRequestError, projectMessageForWire} from "../../images/wire.js";
import {projectImagesForRequest} from "../../images/request.js";
import type {LLMProviderName} from "../providerRegistry.js";
import {ContextLengthError, isContextLengthResponse} from "../errors.js";
import {imageReferences} from "../../images/content.js";
import {
    abortableDelay,
    normalizeTurnAbortReason,
    throwIfTurnAborted,
    TurnInterruptedError,
} from "../../runtime/abort.js";
import {beginPromptLog, finishPromptLogRun} from "../promptLog.js";
import type {LLMCallOptions, LLMCallResult, LLMRetryInfo, LLMStreamProgress, Message, PromptLogResponse, TokenUsage,} from "../types.js";
import {consumeOpenAICompatibleSSE, OpenAICompatibleProtocolError} from "./openAICompatibleStream.js";
import {Buffer} from "node:buffer";
import {reasoningStateSchema, type ReasoningState} from "../reasoning.js";

const LLM_MAX_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 800;
const LLM_STREAM_IDLE_TIMEOUT_MS = 300_000;
const LLM_STREAM_IDLE_WARNING_MS = 60_000;
const LLM_OUTPUT_STALL_TIMEOUT_MS = 60_000;
const LLM_MAX_OUTPUT_STALL_RETRIES = 2;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

interface OpenAICompatibleCallerConfig {
    retryBaseDelayMs: number;
    streamIdleTimeoutMs: number;
    outputStallTimeoutMs: number;
}

const defaultCallerConfig: OpenAICompatibleCallerConfig = {
    retryBaseDelayMs: LLM_RETRY_BASE_DELAY_MS,
    streamIdleTimeoutMs: LLM_STREAM_IDLE_TIMEOUT_MS,
    outputStallTimeoutMs: LLM_OUTPUT_STALL_TIMEOUT_MS,
};

type ChatCompletionsRequest = {
    model: string;
    messages: unknown[];
    tools?: unknown[];
    stream: true;
    [key: string]: unknown;
};

export interface OpenAICompatibleEndpoint {
    /** For actionable error messages only; never sent remotely. */
    displayName: string;
    toolImages?: boolean;
    baseUrl: string;
    apiKey: string;
    /** Vendor extensions cannot override model/messages/tools/stream. */
    requestFields?: Record<string, unknown>;
    /** Enable replay for this source's compatible models, including text-only replies. */
    reasoningSource?: LLMProviderName;
    /** After two deep-reasoning stalls, disable thinking for the final request. */
    disableThinkingOnFinalStallRetry?: boolean;
}

function toProviderMessages(
    messages: readonly Message[],
    reasoningScope: string | undefined
): Message[] {
    return messages.map((message) => {
        if (
            message.role !== "assistant" ||
            message.reasoning === undefined ||
            message.reasoning.scope === reasoningScope
        ) {
            return message;
        }
        return {
            role: "assistant",
            content: message.content,
            ...(message.tool_calls ? {tool_calls: message.tool_calls} : {}),
        };
    });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return signal
        ? abortableDelay(ms, signal)
        : new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
    return (
        status === 408 ||
        status === 409 ||
        status === 425 ||
        status === 429 ||
        status === 529 ||
        (status >= 500 && status <= 599)
    );
}

function formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

function redactSecret(value: string, secret: string): string {
    return secret ? value.replaceAll(secret, "[REDACTED]") : value;
}

async function readErrorResponse(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    try {
        while (bytes < MAX_ERROR_RESPONSE_BYTES) {
            const part = await reader.read();
            if (part.done) break;
            const remaining = MAX_ERROR_RESPONSE_BYTES - bytes;
            if (part.value.length > remaining) {
                chunks.push(part.value.subarray(0, remaining));
                bytes += remaining;
                truncated = true;
                break;
            }
            chunks.push(part.value);
            bytes += part.value.length;
        }
        if (bytes >= MAX_ERROR_RESPONSE_BYTES) truncated = true;
    } finally {
        if (truncated) {
            await reader.cancel("LLM error body size limit reached")
                .catch(() => undefined);
        }
        reader.releaseLock();
    }
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
        .toString("utf8");
    return truncated ? `${text}\n[response truncated]` : text;
}

function retryDelayMs(
    attempt: number,
    baseDelayMs = LLM_RETRY_BASE_DELAY_MS
): number {
    return baseDelayMs * Math.pow(2, attempt - 1);
}

function emptyUsage(): TokenUsage {
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
    };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
    return {
        prompt_tokens: left.prompt_tokens + right.prompt_tokens,
        completion_tokens: left.completion_tokens + right.completion_tokens,
        total_tokens: left.total_tokens + right.total_tokens,
    };
}

function toChatCompletionsUrl(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, "");
    return normalized.endsWith("/chat/completions")
        ? normalized
        : `${normalized}/chat/completions`;
}

function createRequestBody(
    options: LLMCallOptions,
    requestFields: Record<string, unknown> | undefined,
    disableThinking: boolean,
    reasoningScope: string | undefined
): ChatCompletionsRequest {
    const effectiveRequestFields = {...requestFields};
    if (disableThinking) {
        effectiveRequestFields.thinking = {type: "disabled"};
    }
    const tools = options.tools.map((tool) => ({
        type: tool.type,
        function: {...tool.function},
    }));
    return {
        ...effectiveRequestFields,
        model: options.model,
        messages: toProviderMessages(
            options.messages,
            reasoningScope
        ).map(projectMessageForWire),
        ...(tools.length > 0 ? {tools} : {}),
        stream: true,
    };
}

function createIdleRequestSignal(
    parent: AbortSignal | undefined,
    timeoutMs: number,
    outputStallTimeoutMs: number,
    onWarning: (idleMilliseconds: number) => void
) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let warningTimer: ReturnType<typeof setTimeout> | undefined;
    let outputStallWarningTimer: ReturnType<typeof setTimeout> | undefined;
    let outputStallTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let outputStalled = false;
    const abortFromParent = () => controller.abort(parent?.reason);

    if (parent?.aborted) abortFromParent();
    else parent?.addEventListener("abort", abortFromParent, {once: true});

    const reset = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (warningTimer !== undefined) clearTimeout(warningTimer);
        const warningMs = Math.min(LLM_STREAM_IDLE_WARNING_MS, timeoutMs / 2);
        warningTimer = setTimeout(() => onWarning(warningMs), warningMs);
        warningTimer.unref?.();
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort({kind: "timeout", timeoutMs});
        }, timeoutMs);
        timer.unref?.();
    };
    const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (warningTimer !== undefined) clearTimeout(warningTimer);
        if (outputStallWarningTimer !== undefined) {
            clearTimeout(outputStallWarningTimer);
        }
        if (outputStallTimer !== undefined) clearTimeout(outputStallTimer);
        parent?.removeEventListener("abort", abortFromParent);
    };
    const recordCompletion = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (warningTimer !== undefined) clearTimeout(warningTimer);
        if (outputStallWarningTimer !== undefined) {
            clearTimeout(outputStallWarningTimer);
        }
        if (outputStallTimer !== undefined) clearTimeout(outputStallTimer);
        timer = undefined;
        warningTimer = undefined;
        outputStallWarningTimer = undefined;
        outputStallTimer = undefined;
    };
    const recordProgress = () => {
        if (outputStallWarningTimer !== undefined) {
            clearTimeout(outputStallWarningTimer);
        }
        if (outputStallTimer !== undefined) clearTimeout(outputStallTimer);
        const warningMs = Math.max(1, Math.floor(outputStallTimeoutMs / 2));
        outputStallWarningTimer = setTimeout(
            () => onWarning(warningMs),
            warningMs
        );
        outputStallWarningTimer.unref?.();
        outputStallTimer = setTimeout(() => {
            outputStalled = true;
            controller.abort({
                kind: "output-stall-timeout",
                timeoutMs: outputStallTimeoutMs,
            });
        }, outputStallTimeoutMs);
        outputStallTimer.unref?.();
    };
    reset();

    return {
        signal: controller.signal,
        reset,
        recordProgress,
        recordCompletion,
        cleanup,
        didTimeOut: () => timedOut,
        didOutputStall: () => outputStalled,
    };
}

async function callOpenAICompatibleCore(
    options: LLMCallOptions,
    endpoint: OpenAICompatibleEndpoint,
    config: OpenAICompatibleCallerConfig
): Promise<LLMCallResult> {
    const url = toChatCompletionsUrl(endpoint.baseUrl);
    const reasoningScope = endpoint.reasoningSource === undefined ? undefined : createHash("sha256")
        .update(JSON.stringify([endpoint.reasoningSource, url, options.model])).digest("hex");
    const requestTimeoutMs = config.streamIdleTimeoutMs;
    const outputStallTimeoutMs = config.outputStallTimeoutMs;
    let outputStallRetries = 0;
    let responseRetries = 0;
    let completedRetryUsage = emptyUsage();

    if (options.signal) throwIfTurnAborted(options.signal);
    const providerMessages = projectImagesForRequest(toProviderMessages(options.messages, reasoningScope));
    const hasImages = providerMessages.some(message => imageReferences(message.content).length > 0);
    const logPreparationFailure = (error: unknown) => {
        const log = beginPromptLog(options.storage, options.cwd, options.kind, options.model,
            {messages: providerMessages.map(projectMessageForWire), model: options.model,
                requestSent: false, imagesSubmitted: false, preparationStage: "images"},
            [endpoint.apiKey], options.trace, 1);
        log.finish({error: options.signal?.aborted ? "Image request preparation cancelled; request was not sent"
            : error instanceof ImageRequestError ? error.message
                : "Stored image preparation failed; request was not sent. Original history and references are preserved."});
    };
    let wireMessages: unknown[];
    try {
        wireMessages = await encodeImageMessages({messages: providerMessages, supported: endpoint.toolImages === true, readImage: options.readImage, signal: options.signal});
    } catch (error) {
        logPreparationFailure(error);
        throw error;
    }
    await options.onText?.({type: "reset"});
    for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
        if (options.signal) throwIfTurnAborted(options.signal);
        const disableThinking =
            endpoint.disableThinkingOnFinalStallRetry === true &&
            outputStallRetries >= LLM_MAX_OUTPUT_STALL_RETRIES;
        const requestBody = createRequestBody(
            options,
            endpoint.requestFields,
            disableThinking,
            reasoningScope
        );
        requestBody.messages = wireMessages;
        const requestJson = JSON.stringify(requestBody);
        if (hasImages && Buffer.byteLength(requestJson) > 20 * 1024 * 1024) {
            const error = new ImageRequestError("Encoded multimodal request exceeds 20 MiB; request was not sent");
            logPreparationFailure(error);
            throw error;
        }
        const promptLog = beginPromptLog(
            options.storage,
            options.cwd,
            options.kind,
            options.model,
            {...requestBody, messages: providerMessages.map(projectMessageForWire), ...(hasImages ? {imagesSubmitted: true} : {})},
            [endpoint.apiKey], options.trace, attempt
        );
        let lastStreamProgress: LLMStreamProgress | undefined;
        const finishPromptLog = (response: PromptLogResponse) =>
            promptLog.finish(response);
        const requestSignal = createIdleRequestSignal(
            options.signal,
            requestTimeoutMs,
            outputStallTimeoutMs,
            (idleMilliseconds) => {
                options.onStreamProgress?.({
                    phase: "stalled",
                    outputCharacters:
                        lastStreamProgress?.outputCharacters ?? 0,
                    estimatedOutputTokens:
                        lastStreamProgress?.estimatedOutputTokens ?? 0,
                    ...(lastStreamProgress?.toolName
                        ? {toolName: lastStreamProgress.toolName}
                        : {}),
                    idleMilliseconds,
                });
            }
        );
        let failureLogged = false;
        // One owner for recovery: cleanup, diagnostics, draft withdrawal and backoff.
        const recover = async (failure: {
            reason: LLMRetryInfo["reason"];
            message: string;
            allowed: boolean;
            immediate?: boolean;
            details?: {usage: TokenUsage; rawResponse: Record<string, unknown>};
        }): Promise<void> => {
            const canRetry = failure.allowed && attempt < LLM_MAX_ATTEMPTS;
            requestSignal.cleanup();
            const message = `${failure.message} (attempted ${attempt}/${LLM_MAX_ATTEMPTS} times); tools from this response were not executed${canRetry ? "; retrying the model request" : "; retry budget exhausted"}`;
            finishPromptLog({
                ...failure.details,
                error: message,
                rawResponse: {
                    ...failure.details?.rawResponse,
                    recovery: {reason: failure.reason, attempt, maxAttempts: LLM_MAX_ATTEMPTS, willRetry: canRetry},
                },
            });
            failureLogged = true;
            if (!canRetry) throw new Error(message);
            await options.onText?.({type: "reset"});
            options.onStreamProgress?.({
                phase: "retrying", outputCharacters: 0, estimatedOutputTokens: 0,
                retry: {reason: failure.reason, attempt: attempt + 1, maxAttempts: LLM_MAX_ATTEMPTS},
            });
            if (!failure.immediate) await sleep(retryDelayMs(attempt, config.retryBaseDelayMs), options.signal);
        };
        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${endpoint.apiKey}`,
                },
                body: requestJson,
                signal: requestSignal.signal,
            });
        } catch (error) {
            const userInterrupted = options.signal?.aborted === true;
            const timedOut = requestSignal.didTimeOut();
            requestSignal.cleanup();
            if (userInterrupted) {
                finishPromptLog({error: "fetch cancelled"});
                throw new TurnInterruptedError(
                    normalizeTurnAbortReason(options.signal?.reason)
                );
            }
            // Replaying a long request after a generation timeout usually repeats the delay; retry actual connection failures only.
            if (timedOut) {
                finishPromptLog({error: `Timed out waiting for the first stream event (${requestTimeoutMs}ms)`});
                throw new Error(`LLM timed out waiting for the first stream event (${requestTimeoutMs}ms)`);
            }
            await recover({reason: "connection", message: `LLM fetch failed: ${redactSecret(formatError(error), endpoint.apiKey)}`, allowed: true});
            continue;
        }

        try {
            if (!response.ok) {
                const errorBody = await readErrorResponse(response);
                const contextLengthExceeded = isContextLengthResponse(response.status, errorBody);
                const text = redactSecret(
                    hasImages ? "[Image request error body hidden to prevent echoed image data from leaking]" : errorBody,
                    endpoint.apiKey
                );
                const retryable = isRetryableStatus(response.status);
                if (retryable) {
                    await recover({reason: "http", message: `LLM API error: ${response.status} - ${text.slice(0, 500)}`, allowed: true});
                    continue;
                }
                finishPromptLog({
                    error: `API ${response.status} (attempt ${attempt}/${LLM_MAX_ATTEMPTS}): ${text.slice(0, 500)}`,
                });
                failureLogged = true;
                if (contextLengthExceeded) throw new ContextLengthError();
                throw new Error(
                    `LLM API error: ${response.status} - ${text.slice(0, 500)}`
                );
            }

            if (!response.body) {
                const allowed = responseRetries++ < 1;
                await recover({reason: "empty_stream", message: `${endpoint.displayName} stream response has no body`, allowed});
                continue;
            }
            requestSignal.reset();
            // Heartbeat/empty SSE events reset transport idle, but must not keep a
            // generation alive forever without any model output.
            requestSignal.recordProgress();
            const streamed = await consumeOpenAICompatibleSSE({
                body: response.body,
                signal: requestSignal.signal,
                onActivity: requestSignal.reset,
                onCompletionSignal: requestSignal.recordCompletion,
                onText: text => options.onText?.({type: "delta", text}),
                onProgress: (progress) => {
                    requestSignal.recordProgress();
                    lastStreamProgress = progress;
                    options.onStreamProgress?.(progress);
                },
            });
            const emptyResponse =
                streamed.content.trim().length === 0 &&
                streamed.toolCalls.length === 0;
            const responseDetails = {
                stream: true,
                provider: endpoint.displayName,
                finishReason: streamed.finishReason,
                contentLength: streamed.content.length,
                reasoningContentLength: streamed.reasoningContent.length,
                // Diagnostics only; provider-specific History/replay rules remain unchanged.
                ...(streamed.reasoningContent.trim().length > 0
                    ? {reasoning_content: streamed.reasoningContent}
                    : {}),
                ...(streamed.reasoningDetails.length ? {reasoning_details: streamed.reasoningDetails} : {}),
                toolCallCount: streamed.toolCalls.length,
            };
            if (emptyResponse) {
                completedRetryUsage = addUsage(
                    completedRetryUsage,
                    streamed.usage
                );
                await recover({
                    reason: "empty_response", allowed: true,
                    message: "LLM returned an empty response: no valid text or tool calls (reasoning is not a substitute for text)",
                    details: {usage: streamed.usage, rawResponse: responseDetails},
                });
                continue;
            }
            const content = streamed.content.trim().length > 0 ? streamed.content : null;
            let reasoning: ReasoningState | undefined;
            if (reasoningScope !== undefined) {
                if (endpoint.reasoningSource === "openrouter" && (streamed.reasoningContent.trim() || streamed.reasoningDetails.length)) {
                    reasoning = {format: "openrouter", content: streamed.reasoningContent, scope: reasoningScope, details: streamed.reasoningDetails};
                } else if (streamed.reasoningContent.trim()) {
                    reasoning = {content: streamed.reasoningContent, scope: reasoningScope};
                }
                if (reasoning && !reasoningStateSchema.safeParse(reasoning).success) throw new Error("Reasoning replay state exceeds supported limits");
            }
            const message: Message = {
                role: "assistant",
                content,
                ...(streamed.toolCalls.length > 0
                    ? {tool_calls: streamed.toolCalls}
                    : {}),
                ...(reasoning ? {reasoning} : {}),
            };

            finishPromptLog({
                usage: streamed.usage,
                rawMessage: message,
                rawResponse: responseDetails,
            });
            return {
                message,
                toolCalls: streamed.toolCalls,
                usage: addUsage(completedRetryUsage, streamed.usage),
                ...(streamed.usage.total_tokens > 0
                    ? {
                        contextUsage: {
                            inputTokens: streamed.usage.prompt_tokens,
                            tokenCount: streamed.usage.total_tokens,
                        },
                    }
                    : {}),
            };
        } catch (error) {
            if (options.signal?.aborted) {
                if (!failureLogged) finishPromptLog({error: "Request cancelled"});
                throw new TurnInterruptedError(
                    normalizeTurnAbortReason(options.signal.reason)
                );
            }
            // A recovery callback/backoff failure must not become another retry.
            if (failureLogged) throw error;
            if (requestSignal.didOutputStall()) {
                const progressDescription = lastStreamProgress
                    ? ` (last phase: ${lastStreamProgress.phase}${lastStreamProgress.toolName ? `:${lastStreamProgress.toolName}` : ""}; received approximately ${lastStreamProgress.estimatedOutputTokens} tokens)`
                    : "(no valid output delta received yet)";
                const canRetry =
                    outputStallRetries < LLM_MAX_OUTPUT_STALL_RETRIES &&
                    attempt < LLM_MAX_ATTEMPTS;
                const nextRetryDisablesThinking =
                    canRetry &&
                    endpoint.disableThinkingOnFinalStallRetry === true &&
                    outputStallRetries + 1 >= LLM_MAX_OUTPUT_STALL_RETRIES;
                const retryDescription = nextRetryDisablesThinking
                    ? "; disabling deep reasoning for one final retry"
                    : canRetry
                      ? "; retrying once with the original parameters"
                      : "";
                if (canRetry) outputStallRetries += 1;
                await recover({reason: "output_stall", allowed: canRetry, immediate: true,
                    message: `LLM output has had no new delta for ${outputStallTimeoutMs} ms${retryDescription}${progressDescription}`});
                continue;
            }
            if (requestSignal.didTimeOut()) {
                finishPromptLog({
                    error: `Stream idle timeout: ${requestTimeoutMs}ms: ${formatError(error)}`,
                });
                throw new Error(`LLM stream has received no data for ${requestTimeoutMs} ms`);
            }
            if (error instanceof OpenAICompatibleProtocolError) {
                const allowed = responseRetries++ < 1;
                completedRetryUsage = addUsage(completedRetryUsage, error.usage);
                const code = error.diagnostic.code;
                await recover({
                    reason: code === "stream_disconnected" || code === "empty_stream" || code === "invalid_json" ? code : "protocol",
                    message: error.message, allowed,
                    details: {usage: error.usage, rawResponse: {stream: true, provider: endpoint.displayName, protocolFailure: error.diagnostic}},
                });
                continue;
            }
            const safeError = redactSecret(formatError(error), endpoint.apiKey).slice(0, 1000);
            finishPromptLog({error: `Stream failed: ${safeError}`});
            throw new Error(safeError);
        } finally {
            requestSignal.cleanup();
        }
    }

    throw new Error("LLM API error: retry loop exhausted unexpectedly");
}

export function createOpenAICompatibleCaller(
    overrides: Partial<OpenAICompatibleCallerConfig> = {}
) {
    const config: OpenAICompatibleCallerConfig = {
        ...defaultCallerConfig,
        ...overrides,
    };
    return async (options: LLMCallOptions, endpoint: OpenAICompatibleEndpoint) => {
        const trace = options.trace ?? {scope: "maintenance" as const, ownerCwd: options.cwd, runId: randomUUID()};
        try { return await callOpenAICompatibleCore({...options, trace}, endpoint, config); }
        finally { if (!options.trace) finishPromptLogRun(options.storage, trace); }
    };
}

export const callOpenAICompatible = createOpenAICompatibleCaller();
