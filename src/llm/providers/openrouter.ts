import type {LLMProvider} from "../types.js";
import {callOpenAICompatible} from "./openAICompatible.js";

export const openrouterProvider: LLMProvider = {
    name: "openrouter",
    async call(options, source) {
        const apiKey = process.env[source.apiKeyEnv];
        if (!apiKey) throw new Error(`Missing ${source.apiKeyEnv}; check the project .env or ~/.pillar/.env`);
        return callOpenAICompatible(options, {
            displayName: source.label,
            baseUrl: source.baseUrl || "https://openrouter.ai/api/v1",
            apiKey,
            reasoningSource: source.id,
            requestFields: {
                provider: {require_parameters: true},
                // The free NVIDIA endpoint rejects tool_choice=none. No model fallback.
                ...(options.tools.length > 0 ? {tool_choice: "auto"} : {}),
            },
        });
    },
};
