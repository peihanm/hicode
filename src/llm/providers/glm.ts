import type {LLMCallOptions, LLMCallResult, LLMProvider} from "../types.js";
import {callOpenAICompatible, type OpenAICompatibleEndpoint,} from "./openAICompatible.js";

const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

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

        supports(model: string): boolean {
            return model.toLowerCase().includes("glm");
        },

        async call(options, source) {
            const apiKey = process.env[source.apiKeyEnv];
            if (!apiKey) {
                throw new Error(`缺少 ${source.apiKeyEnv}，请检查当前项目 .env 或 ~/.pillar/.env`);
            }

            return callEndpoint(options, {
                displayName: source.label,
                baseUrl: source.baseUrl || DEFAULT_GLM_BASE_URL,
                apiKey,
                requestFields: createGlmRequestFields(),
                disableThinkingOnFinalStallRetry: true,
            });
        },
    };
}

export const glmProvider = createGlmProvider(callOpenAICompatible);
