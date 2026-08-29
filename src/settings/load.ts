import {loadSettingsDocuments} from "./document.js";
import {resolvePillarSettings} from "./resolve.js";
import type {PillarSettingsOverrides, LoadedPillarSettings,} from "./types.js";

export function loadPillarSettings(
    cwd: string = process.cwd(),
    cli: PillarSettingsOverrides = {}
): LoadedPillarSettings {
    const loaded = loadSettingsDocuments(cwd);
    const resolved = resolvePillarSettings(loaded.documents, cli);
    return {...resolved, ...loaded};
}
