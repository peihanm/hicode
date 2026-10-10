import {reasoningCapability, reasoningRequestFields, validateReasoningEffort} from "../reasoningPolicy.js";
import {supportsToolImages} from "../../images/capability.js";
import {PROVIDER_BASE_URLS} from "../providerRegistry.js";
import type {LLMCallOptions, LLMCallResult, LLMProvider} from "../types.js";
import {callOpenAICompatible, type OpenAICompatibleEndpoint,} from "./openAICompatible.js";


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
        name: "glm",

        async call(options, source) {
            validateReasoningEffort(source.id, options.model, options.reasoning ?? "default");
            const apiKey = process.env[source.apiKeyEnv];
            if (!apiKey) {
                throw new Error(`Missing ${source.apiKeyEnv}; check the project .env or ~/.hicode/.env`);
            }

            const capability = reasoningCapability(source.id, options.model);
            const canDisableThinking = capability?.efforts.includes("off") ?? true;
            const effort = options.kind === "task_review" ? capability?.reviewEffort ?? "off" : options.reasoning;
            // Forced-thinking models use their lightest supported level for advisory reviews.
            // Unknown models retain the existing review-off behavior without exposing new choices.
            const requestFields = {
                ...createGlmRequestFields(),
                ...(effort === "off" ? {thinking: {type: "disabled"}} : reasoningRequestFields(source.id, options.model, effort)),
            };
            return callEndpoint(options, {
                displayName: source.label,
                baseUrl: source.baseUrl || PROVIDER_BASE_URLS.glm,
                apiKey,
                toolImages: supportsToolImages(source, options.model),
                requestFields,
                disableThinkingOnFinalStallRetry: canDisableThinking && (options.reasoning ?? "default") === "default",
            });
        },
    };
}

export const glmProvider = createGlmProvider(callOpenAICompatible);
