import {reasoningCapability, reasoningRequestFields, validateReasoningEffort} from "../reasoningPolicy.js";
import {supportsToolImages} from "../../images/request.js";
import {PROVIDER_BASE_URLS} from "../providerRegistry.js";
import type {LLMProvider} from "../types.js";
import {callOpenAICompatible} from "./openAICompatible.js";

export const arkAgentPlanProvider: LLMProvider = {
    name: "ark-agent-plan",
    async call(options, source) {
        validateReasoningEffort(source.id, options.model, options.reasoning ?? "default");
        const apiKey = process.env[source.apiKeyEnv];
        if (!apiKey) throw new Error(`Missing ${source.apiKeyEnv}; check the project .env or ~/.hicode/.env`);
        const capability = reasoningCapability(source.id, options.model);
        const effort = options.reasoning;
        return callOpenAICompatible(options, {
            displayName: source.label,
            baseUrl: source.baseUrl || PROVIDER_BASE_URLS["ark-agent-plan"],
            apiKey,
            toolImages: supportsToolImages(source, options.model),
            requestFields: {stream_options: {include_usage: true},
                ...(capability?.switch === "thinking" ? {thinking: {type: "enabled"}} : {}),
                ...reasoningRequestFields(source.id, options.model, effort)},
            ...(capability && effort !== "off" && options.kind !== "task_review" ? {reasoningSource: source.id} : {}),
        });
    },
};
