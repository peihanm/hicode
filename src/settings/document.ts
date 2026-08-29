import {readFileSync} from "node:fs";
import {homedir} from "node:os";
import {resolve} from "node:path";
import {hasFileSystemErrorCode} from "../persistence/index.js";
import {pillarSettingsFileSchema} from "./schema.js";
import type {LoadedSettingsDocument, SettingsFileSource, SettingsIssue,} from "./types.js";

const KNOWN_TOP_LEVEL_KEYS = new Set([
    "models",
    "permissions",
    "hooks",
    "memory",
    "checkpointing",
    "sandbox",
]);
const KNOWN_MODEL_TARGET_KEYS = new Set(["model", "provider"]);
const KNOWN_MODELS_KEYS = new Set(["primary", "fast"]);
const KNOWN_PERMISSION_KEYS = new Set([
    "defaultMode",
    "allow",
    "ask",
    "deny",
]);
const KNOWN_MEMORY_KEYS = new Set(["enabled", "autoExtract"]);
const KNOWN_CHECKPOINTING_KEYS = new Set(["enabled"]);
const KNOWN_SANDBOX_KEYS = new Set(["enabled", "filesystem", "network"]);
const KNOWN_SANDBOX_FILESYSTEM_KEYS = new Set([
    "allowWrite",
    "denyRead",
    "denyWrite",
]);
const KNOWN_SANDBOX_NETWORK_KEYS = new Set([
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

function bounded(value: string): string {
    return value.length <= MAX_ISSUE_MESSAGE_LENGTH
        ? value
        : `${value.slice(0, MAX_ISSUE_MESSAGE_LENGTH - 1)}…`;
}

export function getSettingsPath(
    cwd: string,
    source: SettingsFileSource
): string {
    if (source === "user") {
        return resolve(homedir(), ".pillar", "settings.json");
    }
    return resolve(
        cwd,
        ".pillar",
        source === "project" ? "settings.json" : "settings.local.json"
    );
}

function getSettingsSources(cwd: string): SettingsSourceLocation[] {
    return (["user", "project", "local"] as const).map((source) => ({
        source,
        path: getSettingsPath(cwd, source),
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
        issues.push({
            source: document.source,
            path: document.path,
            field,
            severity: "warning",
            message: bounded(`未知 Settings 字段 ${field}，已保留但不会生效`),
        });
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

    const {models, permissions, memory, checkpointing, sandbox} = document.value;
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
    if (checkpointing) {
        appendUnknownFieldIssues(
            issues,
            document,
            checkpointing,
            KNOWN_CHECKPOINTING_KEYS,
            "checkpointing"
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
        content = readFileSync(location.path, "utf8");
    } catch (error) {
        if (hasFileSystemErrorCode(error, "ENOENT")) return {issues: []};
        return {
            issues: [{
                source: location.source,
                path: location.path,
                severity: "error",
                message: bounded(
                    `读取 Settings 失败: ${error instanceof Error ? error.message : String(error)}`
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
                        `Settings JSON 无法解析: ${error instanceof Error ? error.message : String(error)}`
                    ),
                }],
            };
        }
    }

    const parsed = pillarSettingsFileSchema.safeParse(raw);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        return {
            issues: [{
                source: location.source,
                path: location.path,
                field: first?.path.join(".") || undefined,
                severity: "error",
                message: first
                    ? formatSchemaIssue(first.path, first.message)
                    : "Settings 格式无效",
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

export function loadSettingsDocuments(cwd: string): LoadedSettingsDocuments {
    const documents: LoadedSettingsDocument[] = [];
    const issues: SettingsIssue[] = [];
    for (const location of getSettingsSources(cwd)) {
        const loaded = loadSettingsDocument(location);
        if (loaded.document) documents.push(loaded.document);
        issues.push(...loaded.issues);
    }
    return {documents, issues};
}
