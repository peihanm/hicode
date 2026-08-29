import type {
    ModelSourceSettings,
    ModelTargetSettings,
    ResolvedPillarSettings,
} from "../settings/types.js";
import {isLLMModelSupported} from "./index.js";

function nonEmpty(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function targetsForSource(source: ModelSourceSettings): ModelTargetSettings[] {
    return source.models
        .filter((model) => isLLMModelSupported(source.id, model.id))
        .map((model) => ({
            source: source.id,
            provider: source.id,
            model: model.id,
            label: model.label,
        }));
}

/** Build one startup catalog from sources whose configured credential exists. */
export function listConfiguredPrimaryModels(
    sources: ResolvedPillarSettings["sources"],
    environment: NodeJS.ProcessEnv = process.env
): ModelTargetSettings[] {
    return Object.values(sources).flatMap((source) =>
        nonEmpty(environment[source.apiKeyEnv]) ? targetsForSource(source) : []
    );
}

export function formatModelTarget(target: ModelTargetSettings): string {
    return target.label;
}
