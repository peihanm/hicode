import {DEFAULT_MODEL} from "../settings/index.js";
import {deepseekProvider} from "./providers/deepseek.js";
import {glmProvider} from "./providers/glm.js";
import {jeniyaProvider} from "./providers/jeniya.js";
import {qwenProvider} from "./providers/qwen.js";
import type {LLMProviderName} from "./providerRegistry.js";
import type {
    LLMCaller,
    LLMCallKind,
    LLMProvider,
    LLMStreamProgress,
    Message,
    OpenAITool,
    TokenUsage,
    ToolCall,
} from "./types.js";

const providers: Record<LLMProviderName, LLMProvider> = {
    glm: glmProvider,
    qwen: qwenProvider,
    deepseek: deepseekProvider,
    jeniya: jeniyaProvider,
};

// LLM 对外统一入口。
// Provider 由配置显式选择，model 只用于能力校验和远端路由。
// agent/context 层不感知具体 endpoint API。
export function createLLMCaller(
    configuredProvider: LLMProviderName
): LLMCaller {
    const provider = providers[configuredProvider];

    return async function callConfiguredLLM(
        messages: Message[],
        tools: OpenAITool[],
        cwd: string = process.cwd(),
        model: string = DEFAULT_MODEL,
        kind: LLMCallKind = "main",
        signal?: AbortSignal,
        onStreamProgress?: (progress: LLMStreamProgress) => void
    ): Promise<{message: Message; toolCalls: ToolCall[]; usage: TokenUsage}> {
        if (!provider.supports(model)) {
            throw new Error(
                `Provider ${configuredProvider} 不支持模型 ${model}。请同时选择与模型匹配的 Provider，或使用支持该模型的 jeniya 中转线路。`
            );
        }
        return provider.call({
            messages,
            tools,
            cwd,
            model,
            kind,
            signal,
            onStreamProgress,
        });
    };
}
