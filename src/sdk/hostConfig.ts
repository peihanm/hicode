import {isAbsolute, resolve} from "node:path";
import {createPillarStorageLayout} from "../persistence/index.js";
import {
    createPillarRootConfiguration,
    normalizePillarFileSources,
    type PillarFileSources,
    type PillarRootContributions,
    type PillarRootConfiguration,
} from "../runtime/rootConfiguration.js";
import {loadPillarSettings} from "../settings/load.js";
import type {
    PillarSettingsFile,
    SettingsIssue,
    SettingsOrigins,
} from "../settings/types.js";
import {PillarSDKError} from "./types.js";

export interface LoadPillarHostConfigOptions {
    cwd: string;
    pillarHome: string;
    workspaceBoundary?: string;
    fileSources: PillarFileSources;
    settingsOverrides?: PillarSettingsFile;
    rootContributions?: PillarRootContributions;
}

export type PillarHostSettingsIssue = SettingsIssue;
export type PillarHostSettingsOrigins = SettingsOrigins;

export interface LoadedPillarHostConfig {
    configuration: PillarRootConfiguration;
    issues: readonly PillarHostSettingsIssue[];
    origins: PillarHostSettingsOrigins;
}

export function loadPillarHostConfig(
    options: LoadPillarHostConfigOptions
): LoadedPillarHostConfig {
    const cwd = requireAbsolutePath(options.cwd, "cwd", "invalid_cwd");
    const pillarHome = requireNonEmptyPath(options.pillarHome, "pillarHome");
    if (!isAbsolute(pillarHome)) {
        throw new PillarSDKError(
            "invalid_pillar_home",
            "loadPillarHostConfig 需要绝对 pillarHome"
        );
    }
    const resolvedCwd = resolve(cwd);
    const storage = createPillarStorageLayout({pillarHome});
    let fileSources: PillarFileSources;
    try {
        fileSources = normalizePillarFileSources(options.fileSources);
    } catch (error) {
        throw new PillarSDKError(
            "invalid_configuration",
            `Root Configuration 无效: ${error instanceof Error ? error.message : String(error)}`,
            {cause: error}
        );
    }
    let loaded: ReturnType<typeof loadPillarSettings>;
    try {
        loaded = loadPillarSettings({
            storage,
            cwd: resolvedCwd,
            sources: fileSources.settings,
            hostSettings: options.settingsOverrides,
        });
    } catch (error) {
        throw new PillarSDKError(
            "invalid_settings",
            `Settings 解析失败: ${error instanceof Error ? error.message : String(error)}`,
            {cause: error}
        );
    }
    const errors = loaded.issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
        throw new PillarSDKError(
            "invalid_settings",
            `Settings 加载失败: ${errors.map(formatSettingsIssue).join("; ")}`
        );
    }
    let configuration: PillarRootConfiguration;
    try {
        configuration = createPillarRootConfiguration({
            cwd: resolvedCwd,
            workspaceBoundary: options.workspaceBoundary ?? resolvedCwd,
            storage,
            settings: loaded.values,
            fileSources,
            rootContributions: options.rootContributions,
        });
    } catch (error) {
        throw new PillarSDKError(
            "invalid_configuration",
            `Root Configuration 无效: ${error instanceof Error ? error.message : String(error)}`,
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
        throw new PillarSDKError(
            `invalid_${name.toLowerCase()}`,
            `loadPillarHostConfig 需要非空 ${name}`
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
        throw new PillarSDKError(
            code,
            `loadPillarHostConfig 需要绝对 ${name}`
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
