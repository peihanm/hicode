import {join} from "node:path";
import type {PillarStorageLayout} from "../persistence/index.js";
import {loadSettingsDocuments, parseHostSettingsDocument} from "./document.js";
import {resolvePillarSettings} from "./resolve.js";
import type {
    PillarSettingsOverrides,
    PillarSettingsFile,
    LoadedPillarSettings,
    SettingsFileSource,
} from "./types.js";

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
    overrides: PillarSettingsOverrides = {},
    sources: readonly SettingsFileSource[] = ["user", "project", "local"],
    hostSettings?: PillarSettingsFile
): LoadedPillarSettings {
    const loaded = loadSettingsDocuments(cwd, {
        userSettingsPath: join(storage.pillarHome, "settings.json"),
        sources,
    });
    const host = hostSettings === undefined
        ? {issues: []}
        : parseHostSettingsDocument(hostSettings);
    const documents = host.document
        ? [...loaded.documents, host.document]
        : loaded.documents;
    const issues = [...loaded.issues, ...host.issues];
    const resolved = resolvePillarSettings(documents, overrides);
    return {...resolved, documents, issues};
}
