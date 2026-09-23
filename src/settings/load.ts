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

interface LoadHiCodeSettingsOptions {
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
    // Skipping an invalid document can silently remove unrelated restrictions.
    const errors = issues.filter(issue => issue.severity === "error");
    if (errors.length) throw new Error("Invalid Settings; loading stopped: " + errors.map(issue => [
        issue.source === "host" ? issue.id : issue.path,
        issue.field ? `(${issue.field})` : undefined,
        issue.message,
    ].filter(Boolean).join(" ")).join("; "));
    const resolved = resolveHiCodeSettings(
        documents,
        options.cliOverrides ?? {}
    );
    return {...resolved, documents, issues};
}
