import {isAbsolute, resolve} from "node:path";
import {createHiCodeStorageLayout} from "../persistence/index.js";
import {
    createHiCodeRootConfiguration,
    normalizeHiCodeFileSources,
    type HiCodeFileSources,
    type HiCodeRootContributions,
    type HiCodeRootConfiguration,
} from "../runtime/rootConfiguration.js";
import {loadHiCodeSettings} from "../settings/load.js";
import type {
    HiCodeSettingsFile,
    SettingsIssue,
    SettingsOrigins,
} from "../settings/types.js";
import {HiCodeSDKError} from "./types.js";

export interface LoadHiCodeHostConfigOptions {
    allowFullAccess?: boolean;
    cwd: string;
    hicodeHome: string;
    workspaceBoundary?: string;
    fileSources: HiCodeFileSources;
    settingsOverrides?: HiCodeSettingsFile;
    rootContributions?: HiCodeRootContributions;
}

export type HiCodeHostSettingsIssue = SettingsIssue;
export type HiCodeHostSettingsOrigins = SettingsOrigins;

export interface LoadedHiCodeHostConfig {
    configuration: HiCodeRootConfiguration;
    issues: readonly HiCodeHostSettingsIssue[];
    origins: HiCodeHostSettingsOrigins;
}

export function loadHiCodeHostConfig(
    options: LoadHiCodeHostConfigOptions
): LoadedHiCodeHostConfig {
    const cwd = requireAbsolutePath(options.cwd, "cwd", "invalid_cwd");
    const hicodeHome = requireNonEmptyPath(options.hicodeHome, "hicodeHome");
    if (!isAbsolute(hicodeHome)) {
        throw new HiCodeSDKError(
            "invalid_hicode_home",
            "loadHiCodeHostConfig requires an absolute hicodeHome"
        );
    }
    const resolvedCwd = resolve(cwd);
    const storage = createHiCodeStorageLayout({hicodeHome});
    let fileSources: HiCodeFileSources;
    try {
        fileSources = normalizeHiCodeFileSources(options.fileSources);
    } catch (error) {
        throw new HiCodeSDKError(
            "invalid_configuration",
            `Invalid Root Configuration: ${error instanceof Error ? error.message : String(error)}`,
            {cause: error}
        );
    }
    let loaded: ReturnType<typeof loadHiCodeSettings>;
    try {
        loaded = loadHiCodeSettings({
            storage,
            cwd: resolvedCwd,
            sources: fileSources.settings,
            hostSettings: options.settingsOverrides,
        });
    } catch (error) {
        throw new HiCodeSDKError(
            "invalid_settings",
            `Settings parsing failed: ${error instanceof Error ? error.message : String(error)}`,
            {cause: error}
        );
    }
    const errors = loaded.issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
        throw new HiCodeSDKError(
            "invalid_settings",
            `Settings loading failed: ${errors.map(formatSettingsIssue).join("; ")}`
        );
    }
    let configuration: HiCodeRootConfiguration;
    try {
        configuration = createHiCodeRootConfiguration({
            allowFullAccess: options.allowFullAccess,
            cwd: resolvedCwd,
            workspaceBoundary: options.workspaceBoundary ?? resolvedCwd,
            storage,
            settings: loaded.values,
            fileSources,
            rootContributions: options.rootContributions,
        });
    } catch (error) {
        throw new HiCodeSDKError(
            "invalid_configuration",
            `Invalid Root Configuration: ${error instanceof Error ? error.message : String(error)}`,
            {cause: error}
        );
    }
    return {
        configuration,
        issues: loaded.issues,
        origins: loaded.origins,
    };
}

function requireNonEmptyPath(value: string, name: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new HiCodeSDKError(
            `invalid_${name.toLowerCase()}`,
            `loadHiCodeHostConfig requires a non-empty ${name}`
        );
    }
    return value.trim();
}

function requireAbsolutePath(
    value: string,
    name: string,
    code: string
): string {
    const path = requireNonEmptyPath(value, name);
    if (!isAbsolute(path)) {
        throw new HiCodeSDKError(
            code,
            `loadHiCodeHostConfig requires an absolute ${name}`
        );
    }
    return path;
}

function formatSettingsIssue(issue: SettingsIssue): string {
    return [
        issue.source === "host" ? issue.id : issue.path,
        issue.field ? `(${issue.field})` : undefined,
        issue.message,
    ].filter(Boolean).join(" ");
}
