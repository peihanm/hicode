import type {ModelTargetSettings} from "../settings/types.js";
import type {ResolvedPillarSettings} from "../settings/types.js";
import {listConfiguredPrimaryModels} from "../llm/modelCatalog.js";

function targetKey(target: ModelTargetSettings): string {
    return `${target.source}\u0000${target.model}`;
}

export interface PrimaryModelRuntime {
    readonly target: ModelTargetSettings;
    readonly available: readonly ModelTargetSettings[];

    select(target: ModelTargetSettings): void;
}

export function createPrimaryModelRuntime(
    initial: ModelTargetSettings,
    sources: ResolvedPillarSettings["sources"],
    available: readonly ModelTargetSettings[] = listConfiguredPrimaryModels(sources)
): PrimaryModelRuntime {
    let target = {...initial};
    const candidates = available.map((candidate) => ({...candidate}));
    const allowed = new Set(candidates.map(targetKey));

    return {
        get target() {
            return {...target};
        },
        get available() {
            return candidates.map((candidate) => ({...candidate}));
        },
        select(next) {
            if (!allowed.has(targetKey(next))) {
                throw new Error(`Model ${next.label} is unavailable`);
            }
            target = {...next};
        },
    };
}
