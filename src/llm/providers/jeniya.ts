import type {LLMProvider} from "../types.js";
import {createGlmRequestFields} from "./glm.js";
import {callOpenAICompatible} from "./openAICompatible.js";

const DEFAULT_JENIYA_BASE_URL = "https://jeniya.cn/v1";

export const jeniyaProvider: LLMProvider = {
    name: "jeniya",

    supports(): boolean {
        return true;
    },

    async call(options) {
        const apiKey = process.env.JENIYA_API_KEY;
        if (!apiKey) {
            throw new Error(
                "缺少 JENIYA_API_KEY，请检查当前项目 .env 或 ~/.pillar/.env"
            );
        }

        const isGlm = options.model.toLowerCase().includes("glm");
        return callOpenAICompatible(options, {
            displayName: "Jeniya",
            baseUrl: process.env.JENIYA_BASE_URL || DEFAULT_JENIYA_BASE_URL,
            apiKey,
            requestFields: isGlm
                ? {
                    ...createGlmRequestFields(options.model),
                    stream_options: {include_usage: true},
                }
                : {stream_options: {include_usage: true}},
            disableThinkingOnFinalStallRetry: isGlm,
        });
    },
};
