import {formatLLMProviderNames, isLLMProviderName, type LLMProviderName,} from "../llm/providerRegistry.js";
import {loadSettingsDocuments} from "./document.js";
import {type EnvironmentSettingsOverrides, resolvePillarSettings,} from "./resolve.js";
import type {PillarSettingsOverrides, LoadedPillarSettings,} from "./types.js";

function readEnvironmentOverrides(): EnvironmentSettingsOverrides {
    const readTarget = (
        providerVariable: string,
        modelVariable: string
    ): Partial<{provider: LLMProviderName; model: string}> | undefined => {
        const rawProvider = process.env[providerVariable]?.trim().toLowerCase();
        let provider: LLMProviderName | undefined;
        if (rawProvider) {
            if (!isLLMProviderName(rawProvider)) {
                throw new Error(
                    `不支持的 LLM Provider: ${rawProvider}。可选值：${formatLLMProviderNames()}`
                );
            }
            provider = rawProvider;
        }
        const model = process.env[modelVariable]?.trim();
        if (!provider && !model) return undefined;
        return {
            ...(provider ? {provider} : {}),
            ...(model ? {model} : {}),
        };
    };
    const primary = readTarget(
        "PILLAR_PRIMARY_PROVIDER",
        "PILLAR_PRIMARY_MODEL"
    );
    const fast = readTarget("PILLAR_FAST_PROVIDER", "PILLAR_FAST_MODEL");
    return {
        ...(primary ? {primary} : {}),
        ...(fast ? {fast} : {}),
    };
}

export function loadPillarSettings(
    cwd: string = process.cwd(),
    cli: PillarSettingsOverrides = {}
): LoadedPillarSettings {
    const loaded = loadSettingsDocuments(cwd);
    const resolved = resolvePillarSettings(
        loaded.documents,
        readEnvironmentOverrides(),
        cli
    );
    return {...resolved, ...loaded};
}
