import {randomUUID} from "node:crypto";
import type {ModelTargetSettings, ResolvedHiCodeSettings} from "../../src/settings/types.js";

/** Exercise the production catalog with isolated, fake credentials and declared models. */
export function configuredModelSources(
    sources: ResolvedHiCodeSettings["sources"],
    targets: readonly ModelTargetSettings[],
    registerCleanup: (cleanup: () => Promise<void>) => void
): ResolvedHiCodeSettings["sources"] {
    const result = structuredClone(sources);
    const fixtureKeys: string[] = [];
    registerCleanup(async () => {for (const key of fixtureKeys) delete process.env[key];});
    for (const source of Object.values(result)) {
        const key = `HICODE_TEST_MODEL_${randomUUID().replaceAll("-", "_")}`;
        source.apiKeyEnv = key;
        source.models = targets.filter(target => target.source === source.id).map(target => ({
            ...source.models.find(model => model.id === target.model), id: target.model, label: target.label,
        }));
        if (source.models.length) {
            process.env[key] = "offline-fixture";
            fixtureKeys.push(key);
        }
    }
    return result;
}
