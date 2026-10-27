import {reasoningCapability, reasoningRequestFields} from "../reasoningPolicy.js";
import type {LLMCallOptions, LLMCallResult, LLMProvider} from "../types.js";
import {prepareOpenAICompatibleEndpoint, callOpenAICompatible, type OpenAICompatibleEndpoint,} from "./openAICompatible.js";


export function createGlmRequestFields(): Record<string, unknown> {
    return {
        tool_stream: true,
        thinking: {type: "enabled"},
    };
}

type OpenAICompatibleCaller = (
    options: LLMCallOptions,
    endpoint: OpenAICompatibleEndpoint
) => Promise<LLMCallResult>;

export function createGlmProvider(
    callEndpoint: OpenAICompatibleCaller
): LLMProvider {
    return {

        async call(options, source) {
            const endpoint = prepareOpenAICompatibleEndpoint(options, source);

            const capability = reasoningCapability(source.id, options.model);
            const canDisableThinking = capability?.efforts.includes("off") ?? true;
            const effort = options.reasoning;
            const requestFields = {
                ...createGlmRequestFields(),
                ...(effort === "off" ? {thinking: {type: "disabled"}} : reasoningRequestFields(source.id, options.model, effort)),
            };
            return callEndpoint(options, {
                ...endpoint,
                requestFields,
                disableThinkingOnFinalStallRetry: canDisableThinking && (options.reasoning ?? "default") === "default",
            });
        },
    };
}

export const glmProvider = createGlmProvider(callOpenAICompatible);
