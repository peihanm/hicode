import type {LLMCallOptions, LLMCallResult, LLMProvider} from "../types.js";
import {callOpenAICompatible, type OpenAICompatibleEndpoint,} from "./openAICompatible.js";
import {getConfiguredReasoningEffort} from "./reasoning.js";

const DEFAULT_GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

export function createGlmRequestFields(model: string): Record<string, unknown> {
    const fields: Record<string, unknown> = {
        tool_stream: true,
        thinking: {type: "enabled"},
    };
    if (model.toLowerCase().includes("glm-5.2")) {
        fields.reasoning_effort = getConfiguredReasoningEffort();
    }
    return fields;
}

type OpenAICompatibleCaller = (
    options: LLMCallOptions,
    endpoint: OpenAICompatibleEndpoint
) => Promise<LLMCallResult>;

export function createGlmProvider(
    callEndpoint: OpenAICompatibleCaller = callOpenAICompatible
): LLMProvider {
    return {
        name: "glm",

        supports(model: string): boolean {
            return model.toLowerCase().includes("glm");
        },

        async call(options) {
            const apiKey = process.env.GLM_API_KEY;
            if (!apiKey) {
                throw new Error("缺少 GLM_API_KEY，请检查当前项目 .env 或 ~/.pillar/.env");
            }

            return callEndpoint(options, {
                displayName: "GLM",
                baseUrl: process.env.GLM_BASE_URL || DEFAULT_GLM_BASE_URL,
                apiKey,
                requestFields: createGlmRequestFields(options.model),
                disableThinkingOnFinalStallRetry: true,
            });
        },
    };
}

export const glmProvider = createGlmProvider();
