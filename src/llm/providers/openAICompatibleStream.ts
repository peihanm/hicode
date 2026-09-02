import type {LLMStreamProgress, TokenUsage, ToolCall,} from "../types.js";
import {
    decodeOpenAICompatibleStreamChunk,
    type OpenAICompatibleStreamChunk,
} from "./openAICompatibleStreamCodec.js";

const COMPLETION_TAIL_GRACE_MS = 500;
const MAX_SSE_EVENT_CHARACTERS = 8 * 1024 * 1024;
const MAX_STREAM_OUTPUT_CHARACTERS = 64 * 1024 * 1024;
const MAX_DATA_EVENTS = 200_000;

export interface OpenAICompatibleStreamResult {
    content: string;
    reasoningContent: string;
    toolCalls: ToolCall[];
    usage: TokenUsage;
    finishReason?: string;
}

function appendToolName(current: string, fragment: string): string {
    if (!current) return fragment;
    if (fragment === current || current.endsWith(fragment)) return current;
    if (fragment.startsWith(current)) return fragment;
    if (current.startsWith(fragment)) return current;
    return current + fragment;
}

function getEventData(event: string): string | undefined {
    const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
    return data || undefined;
}

export async function consumeOpenAICompatibleSSE({
    body,
    signal,
    onActivity,
    onCompletionSignal,
    onProgress,
}: {
    body: ReadableStream<Uint8Array>;
    signal: AbortSignal;
    onActivity: () => void;
    /** finish_reason 后继续短暂读取 usage 与 [DONE]，同时停止生成阶段 watchdog。 */
    onCompletionSignal?: () => void;
    onProgress?: (progress: LLMStreamProgress) => void;
}): Promise<OpenAICompatibleStreamResult> {
    const reader = body.getReader();
    let aborted = signal.aborted;
    const cancelReader = () => {
        aborted = true;
        void reader.cancel(signal.reason).catch(() => undefined);
    };
    if (signal.aborted) cancelReader();
    else signal.addEventListener("abort", cancelReader, {once: true});
    const decoder = new TextDecoder();
    const tools = new Map<number, ToolCall>();
    let buffer = "";
    let content = "";
    let reasoningContent = "";
    let outputCharacters = 0;
    let retainedCharacters = 0;
    let usage: TokenUsage = {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
    };
    let finishReason: string | undefined;
    let done = false;
    let completionSignaled = false;
    let dataEventCount = 0;
    let completionTailTimer: ReturnType<typeof setTimeout> | undefined;

    const clearCompletionTailTimer = () => {
        if (completionTailTimer !== undefined) {
            clearTimeout(completionTailTimer);
            completionTailTimer = undefined;
        }
    };

    const startCompletionTailTimer = () => {
        if (completionTailTimer !== undefined) return;
        completionTailTimer = setTimeout(() => {
            void reader.cancel("finish_reason tail grace elapsed")
                .catch(() => undefined);
        }, COMPLETION_TAIL_GRACE_MS);
        completionTailTimer.unref?.();
    };

    const report = (phase: LLMStreamProgress["phase"], toolName?: string) => {
        onProgress?.({
            phase,
            outputCharacters,
            estimatedOutputTokens: Math.max(1, Math.round(outputCharacters / 4)),
            ...(toolName ? {toolName} : {}),
        });
    };

    const retain = (fragment: string, field: string) => {
        retainedCharacters += fragment.length;
        if (retainedCharacters > MAX_STREAM_OUTPUT_CHARACTERS) {
            throw new Error(
                `OpenAI-compatible stream 累计输出超过 ${MAX_STREAM_OUTPUT_CHARACTERS} 字符（${field}）`
            );
        }
    };

    const processEvent = (event: string) => {
        if (event.length > MAX_SSE_EVENT_CHARACTERS) {
            throw new Error(
                `OpenAI-compatible stream 单个 SSE 事件超过 ${MAX_SSE_EVENT_CHARACTERS} 字符`
            );
        }
        const data = getEventData(event);
        if (!data) return;
        if (data === "[DONE]") {
            done = true;
            clearCompletionTailTimer();
            return;
        }
        dataEventCount += 1;
        if (dataEventCount > MAX_DATA_EVENTS) {
            throw new Error(
                `OpenAI-compatible stream 数据事件超过 ${MAX_DATA_EVENTS} 个`
            );
        }

        let chunk: OpenAICompatibleStreamChunk;
        try {
            chunk = decodeOpenAICompatibleStreamChunk(
                JSON.parse(data) as unknown
            );
        } catch (error) {
            throw new Error(
                `OpenAI-compatible stream 返回无效数据: ${error instanceof Error ? error.message : String(error)}`
            );
        }

        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (!choice) return;
        const eventFinishReason = choice.finish_reason ?? undefined;
        if (eventFinishReason) finishReason = eventFinishReason;

        if (delta) {
            if (delta.reasoning_content) {
                retain(delta.reasoning_content, "reasoning_content");
                reasoningContent += delta.reasoning_content;
                outputCharacters += delta.reasoning_content.length;
                report("reasoning");
            }
            if (delta.content) {
                retain(delta.content, "content");
                content += delta.content;
                outputCharacters += delta.content.length;
                report("content");
            }
            for (const streamed of delta.tool_calls ?? []) {
                const index = streamed.index ?? 0;
                const existing = tools.get(index) ?? {
                    id: "",
                    type: "function" as const,
                    function: {name: "", arguments: ""},
                };
                if (streamed.id) {
                    retain(streamed.id, "tool_call.id");
                    existing.id = streamed.id;
                }
                if (streamed.function?.name) {
                    retain(streamed.function.name, "tool_call.function.name");
                    existing.function.name = appendToolName(
                        existing.function.name,
                        streamed.function.name
                    );
                }
                const argumentDelta = streamed.function?.arguments ?? "";
                retain(argumentDelta, "tool_call.function.arguments");
                existing.function.arguments += argumentDelta;
                outputCharacters += argumentDelta.length;
                tools.set(index, existing);
                report("tool_input", existing.function.name || undefined);
            }
        }

        // 最后一个 delta 也可能带真实内容；先完整消费，再停止生成阶段 watchdog。
        if (eventFinishReason && !completionSignaled) {
            completionSignaled = true;
            onCompletionSignal?.();
            startCompletionTailTimer();
        }
    };

    try {
        while (!done) {
            const part = await reader.read();
            if (part.done) break;
            // Transport activity and model progress are separate signals.
            // SSE comments/heartbeats keep the connection alive, but only
            // decoded output deltas refresh the generation watchdog.
            if (part.value.length > 0) onActivity();
            buffer += decoder.decode(part.value, {stream: true});
            let boundary = buffer.search(/\r?\n\r?\n/);
            while (boundary >= 0) {
                const event = buffer.slice(0, boundary);
                const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
                buffer = buffer.slice(boundary + separator.length);
                processEvent(event);
                if (done) break;
                boundary = buffer.search(/\r?\n\r?\n/);
            }
            if (buffer.length > MAX_SSE_EVENT_CHARACTERS) {
                throw new Error(
                    `OpenAI-compatible stream 未终止事件超过 ${MAX_SSE_EVENT_CHARACTERS} 字符`
                );
            }
        }
        buffer += decoder.decode();
        if (!done && buffer.trim()) processEvent(buffer);
    } finally {
        clearCompletionTailTimer();
        signal.removeEventListener("abort", cancelReader);
        if (completionSignaled && !done) {
            await reader.cancel("finish_reason received").catch(() => undefined);
        }
        reader.releaseLock();
    }

    if (aborted) {
        throw signal.reason instanceof Error
            ? signal.reason
            : new Error(`OpenAI-compatible stream 已中止: ${JSON.stringify(signal.reason)}`);
    }
    if (dataEventCount === 0) {
        throw new Error("OpenAI-compatible stream 已结束，但没有收到任何数据事件");
    }

    const toolCalls = [...tools.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, toolCall]) => toolCall);
    if (!finishReason) {
        throw new Error(
            "OpenAI-compatible stream 在明确完成前已结束，拒绝使用可能截断的响应"
        );
    }
    if (
        (toolCalls.length > 0 && finishReason !== "tool_calls") ||
        (toolCalls.length === 0 && finishReason !== "stop")
    ) {
        throw new Error(
            `OpenAI-compatible stream 以 ${finishReason} 结束，响应不完整或与工具调用不一致`
        );
    }
    const toolCallIds = new Set<string>();
    for (const toolCall of toolCalls) {
        if (!toolCall.id || !toolCall.function.name) {
            throw new Error("OpenAI-compatible stream 返回了缺少 id 或函数名的 tool call");
        }
        if (toolCallIds.has(toolCall.id)) {
            throw new Error("OpenAI-compatible stream 返回了重复 id 的 tool call");
        }
        toolCallIds.add(toolCall.id);
    }

    return {
        content,
        reasoningContent,
        toolCalls,
        usage,
        ...(finishReason ? {finishReason} : {}),
    };
}
