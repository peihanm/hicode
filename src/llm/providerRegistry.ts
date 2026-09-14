export const LLM_PROVIDER_NAMES = [
    "glm",
    "qwen",
    "deepseek",
    "openrouter",
] as const;

export type LLMProviderName = typeof LLM_PROVIDER_NAMES[number];

export const DEFAULT_LLM_PROVIDER: LLMProviderName = "qwen";

const providerNames = new Set<string>(LLM_PROVIDER_NAMES);

export function isLLMProviderName(value: string): value is LLMProviderName {
    return providerNames.has(value);
}

export function formatLLMProviderNames(): string {
    return LLM_PROVIDER_NAMES.join("、");
}

export const QWEN_DEFAULT_BASE_URL = "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";

export const PROVIDER_BASE_URLS: Readonly<Record<LLMProviderName, string>> = Object.freeze({
    qwen: QWEN_DEFAULT_BASE_URL,
    glm: "https://open.bigmodel.cn/api/paas/v4",
    deepseek: "https://api.deepseek.com",
    openrouter: "https://openrouter.ai/api/v1",
});
