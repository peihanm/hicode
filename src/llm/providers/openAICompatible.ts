import {
    abortableDelay,
    normalizeTurnAbortReason,
    throwIfTurnAborted,
    TurnInterruptedError,
} from "../../runtime/abort.js";
import {beginPromptLog} from "../promptLog.js";
import type {LLMCallOptions, LLMCallResult, LLMStreamProgress, Message, PromptLogResponse,} from "../types.js";
import {consumeOpenAICompatibleSSE} from "./openAICompatibleStream.js";

const LLM_MAX_ATTEMPTS = 3;
const LLM_RETRY_BASE_DELAY_MS = 800;
const LLM_STREAM_IDLE_TIMEOUT_MS = 300_000;
const LLM_STREAM_IDLE_WARNING_MS = 60_000;
const LLM_OUTPUT_STALL_TIMEOUT_MS = 120_000;
const LLM_MAX_OUTPUT_STALL_RETRIES = 2;

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
    /** 只用于可操作的错误消息，不会发给远端。 */
    displayName: string;
    baseUrl: string;
    apiKey: string;
    /** 厂商扩展字段；不能覆盖 model/messages/tools/stream。 */
    requestFields?: Record<string, unknown>;
    /** 工具调用轮次在 History 和后续请求中保留 reasoning_content。 */
    preserveToolCallReasoning?: boolean;
    /** 深度推理连续两次停滞后，最后一次请求关闭 thinking。 */
    disableThinkingOnFinalStallRetry?: boolean;
}

function toProviderMessages(
    messages: readonly Message[],
    preserveToolCallReasoning: boolean
): Message[] {
    if (preserveToolCallReasoning) return [...messages];
    return messages.map((message) => {
        if (
            message.role !== "assistant" ||
            message.reasoning_content === undefined
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

function retryDelayMs(
    attempt: number,
    baseDelayMs = LLM_RETRY_BASE_DELAY_MS
): number {
    return baseDelayMs * Math.pow(2, attempt - 1);
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
    preserveToolCallReasoning: boolean
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
            preserveToolCallReasoning
        ),
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
        if (outputStallTimer !== undefined) clearTimeout(outputStallTimer);
        parent?.removeEventListener("abort", abortFromParent);
    };
    const recordCompletion = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (warningTimer !== undefined) clearTimeout(warningTimer);
        if (outputStallTimer !== undefined) clearTimeout(outputStallTimer);
        timer = undefined;
        warningTimer = undefined;
        outputStallTimer = undefined;
    };
    const recordProgress = () => {
        if (outputStallTimer !== undefined) clearTimeout(outputStallTimer);
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
    const requestTimeoutMs = config.streamIdleTimeoutMs;
    const outputStallTimeoutMs = config.outputStallTimeoutMs;
    let outputStallRetries = 0;

    for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
        if (options.signal) throwIfTurnAborted(options.signal);
        const disableThinking =
            endpoint.disableThinkingOnFinalStallRetry === true &&
            outputStallRetries >= LLM_MAX_OUTPUT_STALL_RETRIES;
        const requestBody = createRequestBody(
            options,
            endpoint.requestFields,
            disableThinking,
            endpoint.preserveToolCallReasoning === true
        );
        const promptLog = beginPromptLog(
            options.storage,
            options.cwd,
            options.kind,
            options.model,
            requestBody
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
        let response: Response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${endpoint.apiKey}`,
                },
                body: JSON.stringify(requestBody),
                signal: requestSignal.signal,
            });
        } catch (error) {
            const userInterrupted = options.signal?.aborted === true;
            const timedOut = requestSignal.didTimeOut();
            finishPromptLog({
                error: `${userInterrupted ? "fetch 已取消" : timedOut ? "等待首个流事件超时" : "fetch 失败"} (attempt ${attempt}/${LLM_MAX_ATTEMPTS}): ${formatError(error)}`,
            });
            requestSignal.cleanup();
            if (userInterrupted) {
                throw new TurnInterruptedError(
                    normalizeTurnAbortReason(options.signal?.reason)
                );
            }
            // 生成超时重放同一个长请求通常只会重复耗时；只重试真正的连接失败。
            if (timedOut) {
                throw new Error(`LLM 等待首个流事件超时（${requestTimeoutMs}ms）`);
            }
            if (attempt < LLM_MAX_ATTEMPTS) {
                await sleep(
                    retryDelayMs(attempt, config.retryBaseDelayMs),
                    options.signal
                );
                continue;
            }
            throw new Error(
                `LLM fetch 失败（已尝试 ${attempt} 次）: ${formatError(error)}`
            );
        }

        let failureLogged = false;
        try {
            if (!response.ok) {
                const text = await response.text();
                const retryable = isRetryableStatus(response.status);
                finishPromptLog({
                    error: `API ${response.status} (attempt ${attempt}/${LLM_MAX_ATTEMPTS}): ${text.slice(0, 500)}`,
                });
                failureLogged = true;
                if (retryable && attempt < LLM_MAX_ATTEMPTS) {
                    requestSignal.cleanup();
                    await sleep(
                        retryDelayMs(attempt, config.retryBaseDelayMs),
                        options.signal
                    );
                    continue;
                }
                const attempts = retryable && attempt > 1 ? `（已尝试 ${attempt} 次）` : "";
                throw new Error(
                    `LLM API 错误${attempts}: ${response.status} - ${text.slice(0, 500)}`
                );
            }

            if (!response.body) {
                throw new Error(`${endpoint.displayName} stream 响应缺少 body`);
            }
            requestSignal.reset();
            const streamed = await consumeOpenAICompatibleSSE({
                body: response.body,
                signal: requestSignal.signal,
                onActivity: requestSignal.reset,
                onCompletionSignal: requestSignal.recordCompletion,
                onProgress: (progress) => {
                    requestSignal.recordProgress();
                    lastStreamProgress = progress;
                    options.onStreamProgress?.(progress);
                },
            });
            const emptyResponse =
                streamed.content.trim().length === 0 &&
                streamed.reasoningContent.trim().length === 0 &&
                streamed.toolCalls.length === 0;
            if (emptyResponse) {
                finishPromptLog({
                    error: `API 返回空响应 (attempt ${attempt}/${LLM_MAX_ATTEMPTS}, finish_reason=${streamed.finishReason ?? "missing"})`,
                });
                failureLogged = true;
                if (attempt < LLM_MAX_ATTEMPTS) {
                    requestSignal.cleanup();
                    await sleep(
                        retryDelayMs(attempt, config.retryBaseDelayMs),
                        options.signal
                    );
                    continue;
                }
                throw new Error(
                    `LLM 返回空响应（已尝试 ${attempt} 次）：没有正文、推理内容或工具调用`
                );
            }
            const streamedContent = streamed.content.trim().length > 0
                ? streamed.content
                : "";
            const content =
                streamedContent ||
                (streamed.toolCalls.length === 0 && streamed.reasoningContent.trim()
                    ? streamed.reasoningContent.trim()
                    : null);
            const message: Message = {
                role: "assistant",
                content,
                ...(streamed.toolCalls.length > 0
                    ? {tool_calls: streamed.toolCalls}
                    : {}),
                ...(endpoint.preserveToolCallReasoning === true &&
                streamed.toolCalls.length > 0 &&
                streamed.reasoningContent.trim().length > 0
                    ? {reasoning_content: streamed.reasoningContent}
                    : {}),
            };

            finishPromptLog({
                usage: streamed.usage,
                rawMessage: message,
                rawResponse: {
                    stream: true,
                    provider: endpoint.displayName,
                    finishReason: streamed.finishReason,
                },
            });
            return {
                message,
                toolCalls: streamed.toolCalls,
                usage: streamed.usage,
            };
        } catch (error) {
            if (options.signal?.aborted) {
                finishPromptLog({
                    error: `请求已取消: ${String(options.signal.reason ?? "unknown")}`,
                });
                throw new TurnInterruptedError(
                    normalizeTurnAbortReason(options.signal.reason)
                );
            }
            if (requestSignal.didOutputStall()) {
                const progressDescription = lastStreamProgress
                    ? `（最后阶段 ${lastStreamProgress.phase}${lastStreamProgress.toolName ? `:${lastStreamProgress.toolName}` : ""}，已接收约 ${lastStreamProgress.estimatedOutputTokens} tokens）`
                    : "（尚未收到有效输出增量）";
                const canRetry =
                    outputStallRetries < LLM_MAX_OUTPUT_STALL_RETRIES &&
                    attempt < LLM_MAX_ATTEMPTS;
                const nextRetryDisablesThinking =
                    canRetry &&
                    endpoint.disableThinkingOnFinalStallRetry === true &&
                    outputStallRetries + 1 >= LLM_MAX_OUTPUT_STALL_RETRIES;
                const retryDescription = nextRetryDisablesThinking
                    ? "，将关闭深度推理进行最后一次重试"
                    : canRetry
                      ? "，将按原参数安全重试一次"
                      : "";
                finishPromptLog({
                    error: `模型输出连续 ${outputStallTimeoutMs}ms 没有新增量${retryDescription}${progressDescription}`,
                });
                if (canRetry) {
                    outputStallRetries += 1;
                    options.onStreamProgress?.({
                        phase: "retrying",
                        outputCharacters: 0,
                        estimatedOutputTokens: 0,
                    });
                    await sleep(
                        retryDelayMs(outputStallRetries, config.retryBaseDelayMs),
                        options.signal
                    );
                    continue;
                }
                throw new Error(
                    `LLM 输出连续 ${outputStallTimeoutMs}ms 没有新增量，${disableThinking ? "关闭深度推理重试后" : "安全重试后"}仍无进展${progressDescription}`
                );
            }
            if (requestSignal.didTimeOut()) {
                finishPromptLog({
                    error: `流空闲超时 ${requestTimeoutMs}ms: ${formatError(error)}`,
                });
                throw new Error(`LLM stream 连续 ${requestTimeoutMs}ms 没有收到数据`);
            }
            if (!failureLogged) {
                finishPromptLog({
                    error: `stream 失败: ${formatError(error)}`,
                });
            }
            throw error;
        } finally {
            requestSignal.cleanup();
        }
    }

    throw new Error("LLM API 错误: retry loop exhausted unexpectedly");
}

export function createOpenAICompatibleCaller(
    overrides: Partial<OpenAICompatibleCallerConfig> = {}
) {
    const config: OpenAICompatibleCallerConfig = {
        ...defaultCallerConfig,
        ...overrides,
    };
    return (options: LLMCallOptions, endpoint: OpenAICompatibleEndpoint) =>
        callOpenAICompatibleCore(options, endpoint, config);
}

export const callOpenAICompatible = createOpenAICompatibleCaller();
