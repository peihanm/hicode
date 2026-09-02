import {deepseekProvider} from "./providers/deepseek.js";
import {glmProvider} from "./providers/glm.js";
import {qwenProvider} from "./providers/qwen.js";
import type {LLMProviderName} from "./providerRegistry.js";
import type {
    LLMCaller,
    LLMCallKind,
    LLMCallResult,
    LLMProvider,
    LLMSourceConnection,
    LLMStreamProgress,
    Message,
    OpenAITool,
} from "./types.js";
import type {PillarStorageLayout} from "../persistence/index.js";

const providers: Record<LLMProviderName, LLMProvider> = {
    glm: glmProvider,
    qwen: qwenProvider,
    deepseek: deepseekProvider,
};

export function isLLMModelSupported(
    provider: LLMProviderName,
    model: string
): boolean {
    return providers[provider].supports(model);
}

// LLM 对外统一入口。
// Provider 由配置显式选择，model 只用于能力校验和远端路由。
// agent/context 层不感知具体 endpoint API。
export function createLLMCaller(
    source: LLMSourceConnection
): LLMCaller {
    const provider = providers[source.id];

    return async function callConfiguredLLM(
        messages: Message[],
        tools: OpenAITool[],
        storage: PillarStorageLayout,
        cwd: string,
        model: string,
        kind: LLMCallKind,
        signal?: AbortSignal,
        onStreamProgress?: (progress: LLMStreamProgress) => void
    ): Promise<LLMCallResult> {
        if (!provider.supports(model)) {
            throw new Error(
                `模型来源 ${source.label} 不支持模型 ${model}`
            );
        }
        return provider.call({
            messages,
            tools,
            storage,
            cwd,
            model,
            kind,
            signal,
            onStreamProgress,
        }, source);
    };
}
