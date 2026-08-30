import {join} from "node:path";
import type {PillarStorageLayout} from "../persistence/index.js";
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

export function loadPillarSettingsFromLayout(
    storage: PillarStorageLayout,
    cwd: string,
    overrides: PillarSettingsOverrides = {}
): LoadedPillarSettings {
    const loaded = loadSettingsDocuments(cwd, {
        userSettingsPath: join(storage.pillarHome, "settings.json"),
    });
    const resolved = resolvePillarSettings(loaded.documents, overrides);
    return {...resolved, ...loaded};
}
