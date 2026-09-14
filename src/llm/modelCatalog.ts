import type {
    ModelSourceSettings,
    ModelTargetSettings,
    ResolvedPillarSettings,
} from "../settings/types.js";

function nonEmpty(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
}

function targetsForSource(source: ModelSourceSettings): ModelTargetSettings[] {
    return source.models
        .map((model) => ({
            source: source.id,
            model: model.id,
            label: model.label,
        }));
}

export function sourceIsAvailable(
    source: ModelSourceSettings,
    environment: NodeJS.ProcessEnv
): boolean {
    return Boolean(nonEmpty(environment[source.apiKeyEnv]));
}

/** Build the startup catalog from sources with configured API keys. */
export function listConfiguredPrimaryModels(
    sources: ResolvedPillarSettings["sources"],
    environment: NodeJS.ProcessEnv = process.env
): ModelTargetSettings[] {
    return Object.values(sources).flatMap((source) =>
        sourceIsAvailable(source, environment) ? targetsForSource(source) : []
    );
}

export function formatModelTarget(target: ModelTargetSettings): string {
    return target.label;
}
