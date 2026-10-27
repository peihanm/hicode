import type {LLMProvider} from "../types.js";
import {prepareOpenAICompatibleEndpoint, callOpenAICompatible} from "./openAICompatible.js";

export const openrouterProvider: LLMProvider = {
    async call(options, source) {
        const endpoint = prepareOpenAICompatibleEndpoint(options, source);
        return callOpenAICompatible(options, {
            ...endpoint,
            reasoningSource: source.id,
            requestFields: {
                provider: {require_parameters: true},
                // The free NVIDIA endpoint rejects tool_choice=none. No model fallback.
                ...(options.tools.length > 0 ? {tool_choice: "auto"} : {}),
            },
        });
    },
};
