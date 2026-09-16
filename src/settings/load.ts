import {getUserSettingsPath} from "../persistence/layout.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import {loadSettingsDocuments, parseHostSettingsDocument} from "./document.js";
import {resolveHiCodeSettings} from "./resolve.js";
import type {
    HiCodeSettingsOverrides,
    HiCodeSettingsFile,
    LoadedHiCodeSettings,
    SettingsFileSource,
} from "./types.js";

export interface LoadHiCodeSettingsOptions {
    storage: HiCodeStorageLayout;
    cwd: string;
    sources?: readonly SettingsFileSource[];
    cliOverrides?: HiCodeSettingsOverrides;
    hostSettings?: HiCodeSettingsFile;
}

export function loadHiCodeSettings(
    options: LoadHiCodeSettingsOptions
): LoadedHiCodeSettings {
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
    const resolved = resolveHiCodeSettings(
        documents,
        options.cliOverrides ?? {}
    );
    return {...resolved, documents, issues};
}
