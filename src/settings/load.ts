import {getSettingsPath, MAX_SETTINGS_BYTES} from "./store.js";
import {resolveHiCodeSettings} from "./resolve.js";
import {readBoundedTextFile} from "../persistence/readTextFile.js";
import {hasFileSystemErrorCode, type HiCodeStorageLayout} from "../persistence/index.js";
import {hicodeHostSettingsSchema, hicodeSettingsFileSchema} from "./schema.js";
import type {LoadedHiCodeSettings, HiCodeSettingsOverrides, LoadedSettingsDocument, HiCodeSettingsFile, SettingsFileSource, SettingsIssue,} from "./types.js";

const MAX_ISSUE_MESSAGE_LENGTH = 300;

interface SettingsSourceLocation {
    source: SettingsFileSource;
    path: string;
}

function bounded(value: string): string {
    return value.length <= MAX_ISSUE_MESSAGE_LENGTH
        ? value
        : `${value.slice(0, MAX_ISSUE_MESSAGE_LENGTH - 1)}…`;
}

function formatSchemaIssue(path: PropertyKey[], message: string): string {
    const field = path.length > 0 ? path.join(".") : "<root>";
    return bounded(`${field}: ${message}`);
}

function collectUnknownFieldIssues(document: Extract<LoadedSettingsDocument, {path: string}>): SettingsIssue[] {
    // The strict form shares all field definitions; its diagnostics identify unknown
    // keys without a second, manually maintained field catalog.
    const strict = hicodeHostSettingsSchema.safeParse(document.value);
    const issues: SettingsIssue[] = strict.success ? [] : strict.error.issues.flatMap(issue =>
        issue.code === "unrecognized_keys" ? issue.keys.map(key => {
            const field = [...issue.path, key].join(".");
            return {source: document.source, path: document.path, field, severity: "warning" as const,
                message: bounded(`Unknown Settings field ${field}; preserved but ignored`)};
        }) : []);
    if (document.value.sources && document.source !== "user") issues.push({
        source: document.source, path: document.path, field: "sources", severity: "warning",
        message: "sources may only be defined in user or Host Settings; this definition was ignored",
    });
    return issues;
}

function loadSettingsDocument(
    location: SettingsSourceLocation
): {document?: LoadedSettingsDocument; issues: SettingsIssue[]} {
    let content: string;
    try {
        content = readBoundedTextFile(location.path, MAX_SETTINGS_BYTES);
    } catch (error) {
        if (hasFileSystemErrorCode(error, "ENOENT")) return {issues: []};
        return {
            issues: [{
                source: location.source,
                path: location.path,
                severity: "error",
                message: bounded(
                    `Failed to read Settings: ${error instanceof Error ? error.message : String(error)}`
                ),
            }],
        };
    }

    let raw: unknown = {};
    if (content.trim()) {
        try {
            raw = JSON.parse(content);
        } catch (error) {
            return {
                issues: [{
                    source: location.source,
                    path: location.path,
                    severity: "error",
                    message: bounded(
                        `Failed to parse Settings JSON: ${error instanceof Error ? error.message : String(error)}`
                    ),
                }],
            };
        }
    }

    const parsed = hicodeSettingsFileSchema.safeParse(raw);
    if (!parsed.success) {
        const first = parsed.error.issues.find(issue => issue.path[0] === "permissions" || issue.path[0] === "context") ?? parsed.error.issues[0];
        return {
            issues: [{
                source: location.source,
                path: location.path,
                field: first?.path.join(".") || undefined,
                severity: "error",
                message: first
                    ? formatSchemaIssue(first.path, first.message)
                    : "Invalid Settings format",
            }],
        };
    }

    const document = {
        source: location.source,
        path: location.path,
        value: parsed.data,
    };
    return {
        document,
        issues: collectUnknownFieldIssues(document),
    };
}

function parseHostSettingsDocument(
    value: HiCodeSettingsFile
): {document?: LoadedSettingsDocument; issues: SettingsIssue[]} {
    const parsed = hicodeHostSettingsSchema.safeParse(value);
    if (!parsed.success) {
        return {
            issues: parsed.error.issues.map((problem) => ({
                source: "host" as const,
                id: "settingsOverrides",
                field: problem.path.join(".") || undefined,
                severity: "error" as const,
                message: formatSchemaIssue(problem.path, problem.message),
            })),
        };
    }
    return {
        document: {
            source: "host",
            id: "settingsOverrides",
            value: parsed.data,
        },
        issues: [],
    };
}

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
    const loaded: {documents: LoadedSettingsDocument[]; issues: SettingsIssue[]} = {documents: [], issues: []};
    for (const source of options.sources ?? ["user", "project", "local"]) {
        const path = getSettingsPath(source === "user" ? {source, storage: options.storage} : {source, cwd: options.cwd});
        const result = loadSettingsDocument({source, path});
        if (result.document) loaded.documents.push(result.document);
        loaded.issues.push(...result.issues);
    }
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
