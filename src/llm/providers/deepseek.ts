import {reasoningRequestFields} from "../reasoningPolicy.js";
import type {LLMProvider} from "../types.js";
import {prepareOpenAICompatibleEndpoint, callOpenAICompatible} from "./openAICompatible.js";


function createDeepSeekRequestFields(): Record<string, unknown> {
    return {
        stream_options: {include_usage: true},
        thinking: {type: "enabled"},
    };
}

export const deepseekProvider: LLMProvider = {

    async call(options, source) {
        const endpoint = prepareOpenAICompatibleEndpoint(options, source);

        return callOpenAICompatible(options, {
            ...endpoint,
            requestFields: {...createDeepSeekRequestFields(), ...reasoningRequestFields(source.id, options.model, options.reasoning)},
            ...(options.reasoning !== "off" && options.kind !== "task_review" ? {reasoningSource: source.id} : {}),
            disableThinkingOnFinalStallRetry: (options.reasoning ?? "default") === "default",
        });
    },
};
