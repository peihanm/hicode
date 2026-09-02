export const LLM_PROVIDER_NAMES = [
    "glm",
    "qwen",
    "deepseek",
    "codex",
] as const;

export type LLMProviderName = typeof LLM_PROVIDER_NAMES[number];

export const DEFAULT_LLM_PROVIDER: LLMProviderName = "codex";

const API_LLM_PROVIDER_NAMES = [
    "glm",
    "qwen",
    "deepseek",
] as const;

export type ApiLLMProviderName = typeof API_LLM_PROVIDER_NAMES[number];

const apiProviderNames = new Set<string>(API_LLM_PROVIDER_NAMES);

const providerNames = new Set<string>(LLM_PROVIDER_NAMES);

export function isLLMProviderName(value: string): value is LLMProviderName {
    return providerNames.has(value);
}

export function isApiLLMProviderName(
    value: string
): value is ApiLLMProviderName {
    return apiProviderNames.has(value);
}

export function formatLLMProviderNames(): string {
    return LLM_PROVIDER_NAMES.join("、");
}
