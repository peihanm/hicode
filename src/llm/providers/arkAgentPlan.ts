import {reasoningCapability, reasoningRequestFields} from "../reasoningPolicy.js";
import type {LLMProvider} from "../types.js";
import {prepareOpenAICompatibleEndpoint, callOpenAICompatible} from "./openAICompatible.js";

export const arkAgentPlanProvider: LLMProvider = {
    async call(options, source) {
        const endpoint = prepareOpenAICompatibleEndpoint(options, source);
        const capability = reasoningCapability(source.id, options.model);
        const effort = options.reasoning;
        return callOpenAICompatible(options, {
            ...endpoint,
            requestFields: {stream_options: {include_usage: true},
                ...(capability?.switch === "thinking" ? {thinking: {type: "enabled"}} : {}),
                ...reasoningRequestFields(source.id, options.model, effort)},
            ...(capability && effort !== "off" && options.kind !== "task_review" ? {reasoningSource: source.id} : {}),
        });
    },
};
