import type {LLMProvider} from "../types.js";
import {callOpenAICompatible} from "./openAICompatible.js";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

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
                `Missing ${source.apiKeyEnv}; check the project .env or ~/.pillar/.env`
            );
        }

        return callOpenAICompatible(options, {
            displayName: source.label,
            baseUrl: source.baseUrl || DEFAULT_DEEPSEEK_BASE_URL,
            apiKey,
            requestFields: createDeepSeekRequestFields(),
            preserveToolCallReasoning: true,
            disableThinkingOnFinalStallRetry: true,
        });
    },
};
