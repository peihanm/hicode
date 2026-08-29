import type {LLMProvider} from "../types.js";
import {callOpenAICompatible} from "./openAICompatible.js";
import {getConfiguredReasoningEffort} from "./reasoning.js";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export function createDeepSeekRequestFields(): Record<string, unknown> {
    return {
        stream_options: {include_usage: true},
        thinking: {type: "enabled"},
        reasoning_effort: getConfiguredReasoningEffort(),
    };
}

export const deepseekProvider: LLMProvider = {
    name: "deepseek",

    supports(model: string): boolean {
        return model.toLowerCase().startsWith("deepseek-");
    },

    async call(options) {
        const apiKey = process.env.DEEPSEEK_API_KEY;
        if (!apiKey) {
            throw new Error(
                "缺少 DEEPSEEK_API_KEY，请检查当前项目 .env 或 ~/.pillar/.env"
            );
        }

        return callOpenAICompatible(options, {
            displayName: "DeepSeek",
            baseUrl:
                process.env.DEEPSEEK_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL,
            apiKey,
            requestFields: createDeepSeekRequestFields(),
            preserveToolCallReasoning: true,
            disableThinkingOnFinalStallRetry: true,
        });
    },
};
