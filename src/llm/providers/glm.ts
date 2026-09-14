import {PROVIDER_BASE_URLS} from "../providerRegistry.js";
import type {LLMCallOptions, LLMCallResult, LLMProvider} from "../types.js";
import {callOpenAICompatible, type OpenAICompatibleEndpoint,} from "./openAICompatible.js";


export function createGlmRequestFields(): Record<string, unknown> {
    return {
        tool_stream: true,
        thinking: {type: "enabled"},
    };
}

type OpenAICompatibleCaller = (
    options: LLMCallOptions,
    endpoint: OpenAICompatibleEndpoint
) => Promise<LLMCallResult>;

export function createGlmProvider(
    callEndpoint: OpenAICompatibleCaller
): LLMProvider {
    return {
        name: "glm",

        async call(options, source) {
            const apiKey = process.env[source.apiKeyEnv];
            if (!apiKey) {
                throw new Error(`Missing ${source.apiKeyEnv}; check the project .env or ~/.pillar/.env`);
            }

            return callEndpoint(options, {
                displayName: source.label,
                baseUrl: source.baseUrl || PROVIDER_BASE_URLS.glm,
                apiKey,
                requestFields: createGlmRequestFields(),
                disableThinkingOnFinalStallRetry: true,
            });
        },
    };
}

export const glmProvider = createGlmProvider(callOpenAICompatible);
