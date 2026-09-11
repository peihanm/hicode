import type {ImageReference} from "../images/content.js";
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
    LLMTextUpdate,
    Message,
    OpenAITool,
} from "./types.js";
import type {PillarStorageLayout} from "../persistence/index.js";

const providers: Record<LLMProviderName, LLMProvider> = {
    glm: glmProvider,
    qwen: qwenProvider,
    deepseek: deepseekProvider,
};

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
        onStreamProgress?: (progress: LLMStreamProgress) => void,
        onText?: (update: LLMTextUpdate) => void | Promise<void>,
        readImage?: (reference: ImageReference) => Promise<Buffer>
    ): Promise<LLMCallResult> {
        return provider.call({
            messages,
            tools,
            storage,
            cwd,
            model,
            kind,
            signal,
            onStreamProgress,
            onText,
            readImage,
        }, source);
    };
}
