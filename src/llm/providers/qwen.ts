import {reasoningRequestFields} from "../reasoningPolicy.js";
import type {LLMProvider} from "../types.js";
import {prepareOpenAICompatibleEndpoint, callOpenAICompatible} from "./openAICompatible.js";

function supportsThinking(model: string): boolean {
    const normalized = model.toLowerCase();
    return !normalized.startsWith("qwen3-coder-next") &&
        !normalized.startsWith("qwen3-coder-plus");
}

function supportsPreservedThinking(model: string): boolean {
    return /^qwen3\.(?:6|7|8)-(?:plus|flash|max)(?:-|$)/i.test(model);
}

export function createQwenRequestFields(
    model: string,
    hasTools: boolean
): Record<string, unknown> {
    return {
        stream_options: {include_usage: true},
        ...(supportsThinking(model) ? {enable_thinking: true} : {}),
        ...(supportsPreservedThinking(model) ? {preserve_thinking: true} : {}),
        ...(hasTools ? {parallel_tool_calls: true} : {}),
    };
}

export const qwenProvider: LLMProvider = {

    async call(options, source) {
        const endpoint = prepareOpenAICompatibleEndpoint(options, source);

        const review = options.kind === "task_review";
        const thinkingOff = options.reasoning === "off";
        const replay = !review && !thinkingOff && (supportsPreservedThinking(options.model) ||
            (source.id === "qwen-token-plan" && options.model === "deepseek-v4.1-flash"));
        const requestFields = {
            ...createQwenRequestFields(options.model, options.tools.length > 0),
            ...reasoningRequestFields(source.id, options.model, options.reasoning),
            ...(thinkingOff ? {
                ...(supportsThinking(options.model) ? {enable_thinking: false} : {}),
                ...(supportsPreservedThinking(options.model) ? {preserve_thinking: false} : {}),
            } : {}),
        };
        return callOpenAICompatible(options, {
            ...endpoint,
            ...(replay ? {reasoningSource: source.id} : {}),
            requestFields,
        });
    },
};
