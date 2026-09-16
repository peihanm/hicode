import {PROVIDER_BASE_URLS} from "../providerRegistry.js";
import {supportsToolImages} from "../../images/capability.js";
import type {LLMProvider} from "../types.js";
import {callOpenAICompatible} from "./openAICompatible.js";

function supportsThinking(model: string): boolean {
    const normalized = model.toLowerCase();
    return !normalized.startsWith("qwen3-coder-next") &&
        !normalized.startsWith("qwen3-coder-plus");
}

function supportsReasoningReplay(model: string): boolean {
    return /^qwen3\.(?:6|7|8)-(?:plus|flash|max)(?:-|$)/i.test(model);
}

export function createQwenRequestFields(
    model: string,
    hasTools: boolean
): Record<string, unknown> {
    return {
        stream_options: {include_usage: true},
        ...(supportsThinking(model) ? {enable_thinking: true} : {}),
        ...(supportsReasoningReplay(model) ? {preserve_thinking: true} : {}),
        ...(hasTools ? {parallel_tool_calls: true} : {}),
    };
}

export const qwenProvider: LLMProvider = {
    name: "qwen",

    async call(options, source) {
        const apiKey = process.env[source.apiKeyEnv];
        if (!apiKey) {
            throw new Error(
                `Missing ${source.apiKeyEnv}; check the project .env or ~/.hicode/.env`
            );
        }

        return callOpenAICompatible(options, {
            displayName: source.label,
            toolImages: supportsToolImages(source, options.model),
            ...(supportsReasoningReplay(options.model) ? {reasoningSource: source.id} : {}),
            baseUrl: source.baseUrl || PROVIDER_BASE_URLS.qwen,
            apiKey,
            requestFields: createQwenRequestFields(
                options.model,
                options.tools.length > 0
            ),
        });
    },
};
