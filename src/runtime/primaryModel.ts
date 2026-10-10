import {validateReasoningEffort, type ReasoningPreference} from "../llm/reasoningPolicy.js";
import type {ModelTargetSettings, ResolvedHiCodeSettings} from "../settings/types.js";
import {listConfiguredPrimaryModels, sourceIsAvailable} from "../llm/modelCatalog.js";

export interface PrimaryModelRuntime {
    readonly target: ModelTargetSettings;
    readonly isConfigured: boolean;
    readonly available: readonly ModelTargetSettings[];
    readonly sources: ResolvedHiCodeSettings["sources"];
    reasoningFor(source: ModelTargetSettings["source"], model: string): ModelTargetSettings["reasoning"];
    updateReasoning(preferences: readonly ReasoningPreference[]): void;
    hasCredential(source: ModelTargetSettings["source"]): boolean;
    select(target: ModelTargetSettings): void;
    updateSources(sources: ResolvedHiCodeSettings["sources"]): void;
}

export function createPrimaryModelRuntime(
    initial: ModelTargetSettings,
    initialSources: ResolvedHiCodeSettings["sources"],
    available?: readonly ModelTargetSettings[],
    initialReasoning: readonly ReasoningPreference[] = []
): PrimaryModelRuntime {
    let target = {...initial};
    let preferences = initialReasoning.map(item => ({...item}));
    const reasoningFor = (source: ModelTargetSettings["source"], model: string) => preferences.find(item => item.source === source && item.model === model)?.effort;
    let sources = structuredClone(initialSources);
    let supplied = available?.map(candidate => ({...candidate}));
    const candidates = () => supplied ?? listConfiguredPrimaryModels(sources);
    return {
        get target() {return {...target};},
        get isConfigured() {return candidates().some(item => item.source === target.source && item.model === target.model);},
        get available() {return candidates().map(candidate => {
            const effort = reasoningFor(candidate.source, candidate.model);
            const {reasoning: _declared, ...identity} = candidate;
            return {...identity, ...(effort && effort !== "default" ? {reasoning: effort} : {})};
        });},
        reasoningFor,
        updateReasoning(next) {
            preferences = next.map(item => ({...item}));
            const {reasoning: _previous, ...identity} = target;
            const effort = reasoningFor(target.source, target.model);
            target = {...identity, ...(effort && effort !== "default" ? {reasoning: effort} : {})};
        },
        get sources() {return structuredClone(sources);},
        hasCredential(source) {return sourceIsAvailable(sources[source], process.env);},
        updateSources(next) {
            sources = structuredClone(next);
            supplied = undefined;
        },
        select(next) {
            const selected = candidates().find(item => item.source === next.source && item.model === next.model);
            if (!selected) throw new Error(`Model ${next.label} is unavailable`);
            const effort = next.reasoning ?? reasoningFor(next.source, next.model);
            validateReasoningEffort(next.source, next.model, effort ?? "default");
            const {reasoning: _declared, ...identity} = selected;
            target = {...identity, ...(effort && effort !== "default" ? {reasoning: effort} : {})};
        },
    };
}
