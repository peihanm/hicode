import {deepseekProvider} from "./providers/deepseek.js";
import {glmProvider} from "./providers/glm.js";
import {qwenProvider} from "./providers/qwen.js";
import {
    type ApiLLMProviderName,
    type LLMProviderName,
    isApiLLMProviderName,
} from "./providerRegistry.js";
import type {
    LLMCaller,
    LLMCallKind,
    LLMProvider,
    LLMSourceConnection,
    LLMStreamProgress,
    Message,
    OpenAITool,
    TokenUsage,
    ToolCall,
} from "./types.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {CodexAppServerRuntimeLike} from "./providers/codex/index.js";
import {createCodexProvider} from "./providers/codex/index.js";

const providers: Record<ApiLLMProviderName, LLMProvider> = {
    glm: glmProvider,
    qwen: qwenProvider,
    deepseek: deepseekProvider,
};

export function isLLMModelSupported(
    provider: LLMProviderName,
    model: string
): boolean {
    return provider === "codex"
        ? model.toLowerCase().startsWith("gpt-")
        : providers[provider].supports(model);
}

// LLM 对外统一入口。
// Provider 由配置显式选择，model 只用于能力校验和远端路由。
// agent/context 层不感知具体 endpoint API。
export function createLLMCaller(
    source: LLMSourceConnection,
    services: {codex?: CodexAppServerRuntimeLike} = {}
): LLMCaller {
    const provider = isApiLLMProviderName(source.id)
        ? providers[source.id]
        : services.codex
            ? createCodexProvider(services.codex)
            : undefined;

    return async function callConfiguredLLM(
        messages: Message[],
        tools: OpenAITool[],
        storage: PillarStorageLayout,
        cwd: string,
        model: string,
        kind: LLMCallKind,
        signal?: AbortSignal,
        onStreamProgress?: (progress: LLMStreamProgress) => void
    ): Promise<{message: Message; toolCalls: ToolCall[]; usage: TokenUsage}> {
        if (!provider) {
            throw new Error("Codex Runtime 未初始化，无法使用 GPT/Codex 模型");
        }
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
