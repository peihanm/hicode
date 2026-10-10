import type {LLMProviderName} from "./providerRegistry.js";

export const REASONING_EFFORTS = ["default", "off", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export interface ReasoningPreference {source: LLMProviderName; model: string; effort: ReasoningEffort}
interface ReasoningCapability {efforts: readonly ReasoningEffort[]; switch: "enable_thinking" | "thinking"; reviewEffort: "off" | "low"}

/** Only confirmed model protocols expose configurable levels; unknown models retain their existing defaults. */
export function reasoningCapability(source: LLMProviderName, model: string): ReasoningCapability | undefined {
    if ((source === "qwen" && /^qwen3\.8-(?:flash|max)$/.test(model)) || (source === "qwen-token-plan" && model === "qwen3.8-flash"))
        return {efforts: ["default", "off", "low", "medium", "xhigh"], switch: "enable_thinking", reviewEffort: "off"};
    if ((source === "qwen-token-plan" && model === "deepseek-v4.1-flash") ||
        (source === "deepseek" && (model === "deepseek-pro" || model === "deepseek-flash")))
        return {efforts: ["default", "off", "low", "high", "max"], switch: source === "deepseek" ? "thinking" : "enable_thinking", reviewEffort: "off"};
    if (source === "glm" && model === "glm-5.2")
        return {efforts: ["default", "off", "high", "max"], switch: "thinking", reviewEffort: "off"};
    if (source === "glm" && (model === "glm-5.3" || model === "glm-5.3-flash"))
        return {efforts: ["default", "low", "high", "max"], switch: "thinking", reviewEffort: "low"};
    return undefined;
}

export function validateReasoningEffort(source: LLMProviderName, model: string, effort: ReasoningEffort): void {
    if (effort !== "default" && !reasoningCapability(source, model)?.efforts.includes(effort))
        throw new Error(`Reasoning ${effort} is not supported by ${source}/${model}`);
}

export function reasoningRequestFields(source: LLMProviderName, model: string, effort: ReasoningEffort = "default"): Record<string, unknown> {
    validateReasoningEffort(source, model, effort);
    const capability = reasoningCapability(source, model);
    if (!capability || effort === "default") return {};
    return {
        ...(capability.switch === "thinking" ? {thinking: {type: effort === "off" ? "disabled" : "enabled"}} : {enable_thinking: effort !== "off"}),
        ...(effort === "off" ? {} : {reasoning_effort: effort}),
    };
}
