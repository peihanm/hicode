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

export interface LoadPillarSettingsOptions {
    storage: PillarStorageLayout;
    cwd: string;
    sources?: readonly SettingsFileSource[];
    cliOverrides?: PillarSettingsOverrides;
    hostSettings?: PillarSettingsFile;
}

export function loadPillarSettings(
    options: LoadPillarSettingsOptions
): LoadedPillarSettings {
    const loaded = loadSettingsDocuments(options.cwd, {
        userSettingsPath: join(options.storage.pillarHome, "settings.json"),
        sources: options.sources ?? ["user", "project", "local"],
    });
    const host = options.hostSettings === undefined
        ? {issues: []}
        : parseHostSettingsDocument(options.hostSettings);
    const documents = host.document
        ? [...loaded.documents, host.document]
        : loaded.documents;
    const issues = [...loaded.issues, ...host.issues];
    const resolved = resolvePillarSettings(
        documents,
        options.cliOverrides ?? {}
    );
    return {...resolved, documents, issues};
}
