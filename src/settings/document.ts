import {readBoundedTextFile} from "../persistence/readTextFile.js";
import {resolve} from "node:path";
import {hasFileSystemErrorCode} from "../persistence/index.js";
import {hicodeHostSettingsSchema, hicodeSettingsFileSchema} from "./schema.js";
import {LLM_PROVIDER_NAMES} from "../llm/providerRegistry.js";
import type {LoadedSettingsDocument, HiCodeSettingsFile, SettingsFileSource, SettingsIssue,} from "./types.js";

const KNOWN_TOP_LEVEL_KEYS = new Set([
    "context",
    "sources",
    "models",
    "permissions",
    "hooks",
    "memory",
    "sandbox",
]);
const KNOWN_MODEL_TARGET_KEYS = new Set(["model", "source"]);
const KNOWN_MODELS_KEYS = new Set(["primary", "fast"]);
const KNOWN_SOURCE_KEYS = new Set(["label", "apiKeyEnv", "baseUrl", "models"]);
const KNOWN_SOURCE_MODEL_KEYS = new Set(["id", "label", "imageInput"]);
const KNOWN_SOURCE_NAMES = new Set<string>(LLM_PROVIDER_NAMES);
const KNOWN_PERMISSION_KEYS = new Set([
    "defaultMode",
    "allow",
    "ask",
    "deny",
    "additionalDirectories",
]);
const KNOWN_MEMORY_KEYS = new Set(["enabled", "autoExtract"]);
const KNOWN_SANDBOX_KEYS = new Set(["enabled", "filesystem", "network"]);
const KNOWN_SANDBOX_FILESYSTEM_KEYS = new Set([
    "denyRead",
    "denyWrite",
]);
const KNOWN_SANDBOX_NETWORK_KEYS = new Set([
    "mode",
    "allowedDomains",
    "allowLocalBinding",
]);
const MAX_ISSUE_MESSAGE_LENGTH = 300;

interface SettingsSourceLocation {
    source: SettingsFileSource;
    path: string;
}

interface LoadedSettingsDocuments {
    documents: LoadedSettingsDocument[];
    issues: SettingsIssue[];
}

function issueForDocument(
    document: LoadedSettingsDocument,
    details: Omit<SettingsIssue, "source" | "path" | "id">
): SettingsIssue {
    return document.source === "host"
        ? {...details, source: "host", id: document.id}
        : {...details, source: document.source, path: document.path};
}

function bounded(value: string): string {
    return value.length <= MAX_ISSUE_MESSAGE_LENGTH
        ? value
        : `${value.slice(0, MAX_ISSUE_MESSAGE_LENGTH - 1)}…`;
}

export function getSettingsPath(
    cwd: string,
    source: SettingsFileSource,
    userSettingsPath?: string
): string {
    if (source === "user") {
        if (!userSettingsPath) {
            throw new Error("User Settings path must be provided by HiCodeStorageLayout");
        }
        return resolve(userSettingsPath);
    }
    return resolve(
        cwd,
        ".hicode",
        source === "project" ? "settings.json" : "settings.local.json"
    );
}

function getSettingsSources(
    cwd: string,
    userSettingsPath: string,
    sources: readonly SettingsFileSource[]
): SettingsSourceLocation[] {
    return sources.map((source) => ({
        source,
        path: getSettingsPath(cwd, source, userSettingsPath),
    }));
}

function formatSchemaIssue(path: PropertyKey[], message: string): string {
    const field = path.length > 0 ? path.join(".") : "<root>";
    return bounded(`${field}: ${message}`);
}

function appendUnknownFieldIssues(
    issues: SettingsIssue[],
    document: LoadedSettingsDocument,
    value: object,
    knownKeys: ReadonlySet<string>,
    prefix = ""
): void {
    for (const key of Object.keys(value)) {
        if (knownKeys.has(key)) continue;
        const field = prefix ? `${prefix}.${key}` : key;
        issues.push(issueForDocument(document, {
            field,
            severity: "warning",
            message: bounded(`Unknown Settings field ${field}; preserved but ignored`),
        }));
    }
}

function collectUnknownFieldIssues(
    document: LoadedSettingsDocument
): SettingsIssue[] {
    const issues: SettingsIssue[] = [];
    appendUnknownFieldIssues(
        issues,
        document,
        document.value,
        KNOWN_TOP_LEVEL_KEYS
    );

    const {sources, models, permissions, memory, sandbox} = document.value;
    if (sources) {
        appendUnknownFieldIssues(
            issues,
            document,
            sources,
            KNOWN_SOURCE_NAMES,
            "sources"
        );
        for (const sourceName of LLM_PROVIDER_NAMES) {
            const source = sources[sourceName];
            if (!source || typeof source !== "object") continue;
            appendUnknownFieldIssues(
                issues,
                document,
                source,
                KNOWN_SOURCE_KEYS,
                `sources.${sourceName}`
            );
            for (const [index, model] of (source.models ?? []).entries()) {
                appendUnknownFieldIssues(
                    issues,
                    document,
                    model,
                    KNOWN_SOURCE_MODEL_KEYS,
                    `sources.${sourceName}.models.${index}`
                );
            }
        }
        if (document.source !== "user" && document.source !== "host") {
            issues.push(issueForDocument(document, {
                field: "sources",
                severity: "warning",
                message: "sources may only be defined in user Settings; this definition was ignored",
            }));
        }
    }
    if (models) {
        appendUnknownFieldIssues(
            issues,
            document,
            models,
            KNOWN_MODELS_KEYS,
            "models"
        );
        for (const target of ["primary", "fast"] as const) {
            if (!models[target]) continue;
            appendUnknownFieldIssues(
                issues,
                document,
                models[target],
                KNOWN_MODEL_TARGET_KEYS,
                `models.${target}`
            );
        }
    }
    if (permissions) {
        appendUnknownFieldIssues(
            issues,
            document,
            permissions,
            KNOWN_PERMISSION_KEYS,
            "permissions"
        );
    }
    if (memory) {
        appendUnknownFieldIssues(
            issues,
            document,
            memory,
            KNOWN_MEMORY_KEYS,
            "memory"
        );
    }
    if (sandbox) {
        appendUnknownFieldIssues(
            issues,
            document,
            sandbox,
            KNOWN_SANDBOX_KEYS,
            "sandbox"
        );
        if (sandbox.filesystem) {
            appendUnknownFieldIssues(
                issues,
                document,
                sandbox.filesystem,
                KNOWN_SANDBOX_FILESYSTEM_KEYS,
                "sandbox.filesystem"
            );
        }
        if (sandbox.network) {
            appendUnknownFieldIssues(
                issues,
                document,
                sandbox.network,
                KNOWN_SANDBOX_NETWORK_KEYS,
                "sandbox.network"
            );
        }
    }
    return issues;
}

function loadSettingsDocument(
    location: SettingsSourceLocation
): {document?: LoadedSettingsDocument; issues: SettingsIssue[]} {
    let content: string;
    try {
        content = readBoundedTextFile(location.path, 4 * 1024 * 1024);
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

    const document: LoadedSettingsDocument = {
        source: location.source,
        path: location.path,
        value: parsed.data,
    };
    return {
        document,
        issues: collectUnknownFieldIssues(document),
    };
}

export function loadSettingsDocuments(
    cwd: string,
    options: {
        userSettingsPath: string;
        sources: readonly SettingsFileSource[];
    }
): LoadedSettingsDocuments {
    const documents: LoadedSettingsDocument[] = [];
    const issues: SettingsIssue[] = [];
    for (const location of getSettingsSources(
        cwd,
        options.userSettingsPath,
        options.sources
    )) {
        const loaded = loadSettingsDocument(location);
        if (loaded.document) documents.push(loaded.document);
        issues.push(...loaded.issues);
    }
    return {documents, issues};
}

export function parseHostSettingsDocument(
    value: HiCodeSettingsFile,
    id = "settingsOverrides"
): {document?: LoadedSettingsDocument; issues: SettingsIssue[]} {
    const parsed = hicodeHostSettingsSchema.safeParse(value);
    if (!parsed.success) {
        return {
            issues: parsed.error.issues.map((problem) => ({
                source: "host" as const,
                id,
                field: problem.path.join(".") || undefined,
                severity: "error" as const,
                message: formatSchemaIssue(problem.path, problem.message),
            })),
        };
    }
    return {
        document: {
            source: "host",
            id,
            value: parsed.data,
        },
        issues: [],
    };
}
