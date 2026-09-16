import type {ModelTargetSettings, ResolvedHiCodeSettings} from "../settings/types.js";
import {listConfiguredPrimaryModels, sourceIsAvailable} from "../llm/modelCatalog.js";

export interface PrimaryModelRuntime {
    readonly target: ModelTargetSettings;
    readonly isConfigured: boolean;
    readonly available: readonly ModelTargetSettings[];
    readonly sources: ResolvedHiCodeSettings["sources"];
    hasCredential(source: ModelTargetSettings["source"]): boolean;
    select(target: ModelTargetSettings): void;
    updateSources(sources: ResolvedHiCodeSettings["sources"]): void;
}

export function createPrimaryModelRuntime(
    initial: ModelTargetSettings,
    initialSources: ResolvedHiCodeSettings["sources"],
    available?: readonly ModelTargetSettings[]
): PrimaryModelRuntime {
    let target = {...initial};
    let sources = structuredClone(initialSources);
    let supplied = available?.map(candidate => ({...candidate}));
    const candidates = () => supplied ?? listConfiguredPrimaryModels(sources);
    return {
        get target() {return {...target};},
        get isConfigured() {return candidates().some(item => item.source === target.source && item.model === target.model);},
        get available() {return candidates().map(candidate => ({...candidate}));},
        get sources() {return structuredClone(sources);},
        hasCredential(source) {return sourceIsAvailable(sources[source], process.env);},
        updateSources(next) {
            sources = structuredClone(next);
            supplied = undefined;
        },
        select(next) {
            const selected = candidates().find(item => item.source === next.source && item.model === next.model);
            if (!selected) throw new Error(`Model ${next.label} is unavailable`);
            target = {...selected};
        },
    };
}
