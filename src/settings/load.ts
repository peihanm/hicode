import {getUserSettingsPath} from "../persistence/layout.js";
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
        userSettingsPath: getUserSettingsPath(options.storage),
        sources: options.sources ?? ["user", "project", "local"],
    });
    const host = options.hostSettings === undefined
        ? {issues: []}
        : parseHostSettingsDocument(options.hostSettings);
    const documents = host.document
        ? [...loaded.documents, host.document]
        : loaded.documents;
    const issues = [...loaded.issues, ...host.issues];
    // Invalid rules must not disappear with a skipped settings document.
    const invalidPermissions = issues.find(issue => issue.severity === "error" &&
        (issue.field === "permissions" || issue.field?.startsWith("permissions.")));
    if (invalidPermissions) throw new Error("Invalid permission configuration; loading stopped: " + invalidPermissions.message);
    const invalidContext = issues.find(issue => issue.severity === "error" &&
        (issue.field === "context" || issue.field?.startsWith("context.")));
    if (invalidContext) throw new Error("Invalid context configuration; loading stopped: " + invalidContext.message);
    const resolved = resolvePillarSettings(
        documents,
        options.cliOverrides ?? {}
    );
    return {...resolved, documents, issues};
}
