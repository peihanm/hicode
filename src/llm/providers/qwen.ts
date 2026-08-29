import type {LLMProvider} from "../types.js";
import {callOpenAICompatible} from "./openAICompatible.js";

const DEFAULT_QWEN_BASE_URL =
    "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

function supportsThinking(model: string): boolean {
    const normalized = model.toLowerCase();
    return !normalized.startsWith("qwen3-coder-next") &&
        !normalized.startsWith("qwen3-coder-plus");
}

export function createQwenRequestFields(
    model: string,
    hasTools: boolean
): Record<string, unknown> {
    return {
        stream_options: {include_usage: true},
        ...(supportsThinking(model) ? {enable_thinking: true} : {}),
        ...(hasTools ? {parallel_tool_calls: true} : {}),
    };
}

export const qwenProvider: LLMProvider = {
    name: "qwen",

    supports(model: string): boolean {
        return model.toLowerCase().startsWith("qwen");
    },

    async call(options) {
        const apiKey = process.env.DASHSCOPE_API_KEY;
        if (!apiKey) {
            throw new Error(
                "缺少 DASHSCOPE_API_KEY，请检查当前项目 .env 或 ~/.pillar/.env"
            );
        }

        return callOpenAICompatible(options, {
            displayName: "Qwen",
            baseUrl: process.env.QWEN_BASE_URL || DEFAULT_QWEN_BASE_URL,
            apiKey,
            requestFields: createQwenRequestFields(
                options.model,
                options.tools.length > 0
            ),
        });
    },
};
