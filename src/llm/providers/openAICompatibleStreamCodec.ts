import type {TokenUsage} from "../types.js";

const MAX_TOOL_CALLS = 128;

interface OpenAICompatibleStreamDeltaToolCall {
    index?: number;
    id?: string;
    type?: string;
    function?: {
        name?: string;
        arguments?: string;
    };
}

export interface OpenAICompatibleStreamChunk {
    choices?: Array<{
        delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: OpenAICompatibleStreamDeltaToolCall[];
        };
        finish_reason?: string | null;
    }>;
    usage?: TokenUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(
    value: unknown,
    field: string
): string | null | undefined {
    if (value === undefined || value === null || typeof value === "string") {
        return value;
    }
    throw new Error(`OpenAI-compatible stream 的 ${field} 必须是字符串或 null`);
}

function decodeUsage(value: unknown): TokenUsage | undefined {
    if (value === undefined || value === null) return undefined;
    if (!isRecord(value)) {
        throw new Error("OpenAI-compatible stream 的 usage 必须是对象");
    }
    const fields = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;
    const result = {} as Record<(typeof fields)[number], number>;
    for (const field of fields) {
        const count = value[field];
        if (!Number.isSafeInteger(count) || (count as number) < 0) {
            throw new Error(
                `OpenAI-compatible stream 的 usage.${field} 必须是非负整数`
            );
        }
        result[field] = count as number;
    }
    return result;
}

function decodeToolCalls(
    value: unknown
): OpenAICompatibleStreamDeltaToolCall[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS) {
        throw new Error(
            `OpenAI-compatible stream 的 delta.tool_calls 必须是不超过 ${MAX_TOOL_CALLS} 项的数组`
        );
    }
    return value.map((item, position) => {
        if (!isRecord(item)) {
            throw new Error(
                `OpenAI-compatible stream 的 tool_calls[${position}] 必须是对象`
            );
        }
        const index = item.index;
        if (
            index !== undefined &&
            (!Number.isSafeInteger(index) ||
                (index as number) < 0 ||
                (index as number) >= MAX_TOOL_CALLS)
        ) {
            throw new Error(
                `OpenAI-compatible stream 的 tool_calls[${position}].index 非法`
            );
        }
        const fn = item.function;
        if (fn !== undefined && !isRecord(fn)) {
            throw new Error(
                `OpenAI-compatible stream 的 tool_calls[${position}].function 必须是对象`
            );
        }
        const type = optionalString(item.type, `tool_calls[${position}].type`);
        if (type !== undefined && type !== null && type !== "function") {
            throw new Error(
                `OpenAI-compatible stream 的 tool_calls[${position}].type 非法`
            );
        }
        return {
            ...(index === undefined ? {} : {index: index as number}),
            ...(item.id === undefined
                ? {}
                : {
                    id: optionalString(
                        item.id,
                        `tool_calls[${position}].id`
                    ) ?? undefined,
                }),
            ...(type === undefined || type === null ? {} : {type}),
            ...(fn === undefined
                ? {}
                : {
                    function: {
                        ...(fn.name === undefined
                            ? {}
                            : {
                                name: optionalString(
                                    fn.name,
                                    `tool_calls[${position}].function.name`
                                ) ?? undefined,
                            }),
                        ...(fn.arguments === undefined
                            ? {}
                            : {
                                arguments: optionalString(
                                    fn.arguments,
                                    `tool_calls[${position}].function.arguments`
                                ) ?? undefined,
                            }),
                    },
                }),
        };
    });
}

export function decodeOpenAICompatibleStreamChunk(
    value: unknown
): OpenAICompatibleStreamChunk {
    if (!isRecord(value)) {
        throw new Error("OpenAI-compatible stream 的数据事件必须是对象");
    }
    const usage = decodeUsage(value.usage);
    if (value.choices === undefined) return usage ? {usage} : {};
    if (!Array.isArray(value.choices)) {
        throw new Error("OpenAI-compatible stream 的 choices 必须是数组");
    }
    const choices = value.choices.map((rawChoice, position) => {
        if (!isRecord(rawChoice)) {
            throw new Error(
                `OpenAI-compatible stream 的 choices[${position}] 必须是对象`
            );
        }
        const finishReason = optionalString(
            rawChoice.finish_reason,
            `choices[${position}].finish_reason`
        );
        const rawDelta = rawChoice.delta;
        if (rawDelta !== undefined && !isRecord(rawDelta)) {
            throw new Error(
                `OpenAI-compatible stream 的 choices[${position}].delta 必须是对象`
            );
        }
        return {
            ...(rawDelta === undefined
                ? {}
                : {
                    delta: {
                        content: optionalString(rawDelta.content, "delta.content"),
                        reasoning_content: optionalString(
                            rawDelta.reasoning_content,
                            "delta.reasoning_content"
                        ),
                        tool_calls: decodeToolCalls(rawDelta.tool_calls),
                    },
                }),
            ...(finishReason === undefined
                ? {}
                : {finish_reason: finishReason}),
        };
    });
    return {...(usage ? {usage} : {}), choices};
}
