import {isAbsolute, resolve} from "node:path";
import {createPillarStorageLayout} from "../persistence/index.js";
import {loadPillarSettingsFromLayout} from "../settings/load.js";
import type {
    ResolvedPillarSettings,
    SettingsIssue,
    SettingsOrigins,
} from "../settings/types.js";
import {PillarSDKError, type PillarOptions} from "./types.js";

export interface LoadPillarHostConfigOptions {
    cwd: string;
    pillarHome: string;
    model?: string;
    source?: ResolvedPillarSettings["models"]["primary"]["source"];
}

export type PillarHostSettingsIssue = SettingsIssue;
export type PillarHostSettingsOrigins = SettingsOrigins;

export interface LoadedPillarHostConfig {
    pillarOptions: Omit<PillarOptions, "host">;
    issues: readonly PillarHostSettingsIssue[];
    origins: PillarHostSettingsOrigins;
}

export function loadPillarHostConfig(
    options: LoadPillarHostConfigOptions
): LoadedPillarHostConfig {
    const cwd = requireNonEmptyPath(options.cwd, "cwd");
    const pillarHome = requireNonEmptyPath(options.pillarHome, "pillarHome");
    if (!isAbsolute(pillarHome)) {
        throw new PillarSDKError(
            "invalid_pillar_home",
            "loadPillarHostConfig 需要绝对 pillarHome"
        );
    }
    const resolvedCwd = resolve(cwd);
    const storage = createPillarStorageLayout({pillarHome});
    let loaded: ReturnType<typeof loadPillarSettingsFromLayout>;
    try {
        loaded = loadPillarSettingsFromLayout(storage, resolvedCwd, {
            model: options.model,
            source: options.source,
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
    return {
        pillarOptions: {
            cwd: resolvedCwd,
            storage,
            settings: loaded.values,
        },
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

function formatSettingsIssue(issue: SettingsIssue): string {
    return [
        issue.path,
        issue.field ? `(${issue.field})` : undefined,
        issue.message,
    ].filter(Boolean).join(" ");
}
