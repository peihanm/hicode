import {supportsToolImages} from "../../images/capability.js";
import {PROVIDER_BASE_URLS} from "../providerRegistry.js";
import type {LLMProvider} from "../types.js";
import {callOpenAICompatible} from "./openAICompatible.js";


function createDeepSeekRequestFields(): Record<string, unknown> {
    return {
        stream_options: {include_usage: true},
        thinking: {type: "enabled"},
    };
}

export const deepseekProvider: LLMProvider = {
    name: "deepseek",

    async call(options, source) {
        const apiKey = process.env[source.apiKeyEnv];
        if (!apiKey) {
            throw new Error(
                `Missing ${source.apiKeyEnv}; check the project .env or ~/.hicode/.env`
            );
        }

        return callOpenAICompatible(options, {
            displayName: source.label,
            baseUrl: source.baseUrl || PROVIDER_BASE_URLS.deepseek,
            apiKey,
            toolImages: supportsToolImages(source, options.model),
            requestFields: createDeepSeekRequestFields(),
            reasoningSource: source.id,
            disableThinkingOnFinalStallRetry: true,
        });
    },
};
