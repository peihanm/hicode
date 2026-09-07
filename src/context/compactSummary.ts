import {isTurnInterruptedError, throwIfTurnAborted,} from "../runtime/abort.js";
import type {LLMCaller, Message} from "../llm/types.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import {getModelInputBudget} from "./window.js";
import {tokenCountWithEstimation} from "./tokens.js";
import {buildCompactPrompt, parseCompactSummary} from "./compactPrompt.js";
import {labelHandoffSources, renderHandoff, type HandoffSources} from "./handoff.js";

const MAX_COMPACT_RETRIES = 3;

interface CompactSummaryDependencies {
    callLLM: LLMCaller;
}

function dropOldestConversationChunk(
    messages: Message[],
    attempt: number
): Message[] {
    const dropRatio = attempt === 1 ? 0.2 : 0.4;
    let start = Math.max(1, Math.floor(messages.length * dropRatio));
    while (start < messages.length && messages[start]?.role !== "user") {
        start += 1;
    }

    if (start >= messages.length) return [];

    return [
        {
            role: "user",
            content: "[为了重试压缩，较早对话已被截断]",
        },
        ...messages.slice(start),
    ];
}

function isPromptTooLongError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /prompt|context|token/i.test(message) &&
        /too long|length|limit|413/i.test(message);
}

export function createCompactSummaryGenerator(
    dependencies: CompactSummaryDependencies
) {
    return (input: Parameters<typeof generateCompactSummaryCore>[0]) =>
        generateCompactSummaryCore(input, dependencies.callLLM);
}

async function generateCompactSummaryCore({
                                              system,
                                              conversation,
                                              signal,
                                              storage,
                                              cwd,
                                              model,
                                              customInstructions,
                                              contextWindow,
                                              sources,
                                          }: {
    system: Extract<Message, { role: "system" }>;
    conversation: Message[];
    signal: AbortSignal;
    storage: PillarStorageLayout;
    cwd: string;
    model: string;
    customInstructions?: string;
    contextWindow?: number;
    sources?: HandoffSources;
}, callLLMImpl: LLMCaller): Promise<string> {
    let messagesToSummarize = sources ? labelHandoffSources(conversation, sources) : conversation;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_COMPACT_RETRIES; attempt++) {
        throwIfTurnAborted(signal);
        const compactMessages: Message[] = [
            system,
            ...messagesToSummarize,
            {role: "user", content: buildCompactPrompt(customInstructions, sources)},
        ];

        try {
            if (tokenCountWithEstimation(compactMessages) > getModelInputBudget(model, contextWindow)) {
                throw new Error("compact prompt too long: 估算已超过输入预算，请缩短输入或固定上下文");
            }
            const {message} = await callLLMImpl(
                compactMessages,
                [],
                storage,
                cwd,
                model,
                "compact",
                signal
            );
            if (message.role !== "assistant" || message.tool_calls?.length) throw new Error("工作交接必须是无工具调用的助手文本");
            const summary = typeof message.content === "string"
                ? sources ? renderHandoff(message.content, sources) : parseCompactSummary(message.content)
                : "";
            if (!summary) throw new Error("compact summary 为空");
            return summary;
        } catch (error) {
            if (isTurnInterruptedError(error, signal)) throw error;
            lastError = error;
            if (!isPromptTooLongError(error) || attempt === MAX_COMPACT_RETRIES - 1) {
                break;
            }
            messagesToSummarize = dropOldestConversationChunk(
                messagesToSummarize,
                attempt + 1
            );
            if (messagesToSummarize.length === 0) break;
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
