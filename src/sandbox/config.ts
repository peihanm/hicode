import {homedir} from "node:os";
import {isAbsolute, resolve} from "node:path";
import type {SandboxRuntimeConfig} from "@anthropic-ai/sandbox-runtime";
import type {ResolvedSandboxSettings} from "./types.js";

// Keep a final filename wildcard: ASRT strips a trailing /** before invoking
// Seatbelt, which otherwise turns nested-directory protection into an exact match.
const MANDATORY_DENY_WRITE = [".git", ".hicode", ".env", ".env*", "**/.git", "**/.git/**/*", "**/.hicode", "**/.hicode/**/*", "**/.env*"];

function resolveSandboxPath(cwd: string, configuredPath: string): string {
    if (configuredPath === "~") return homedir();
    if (configuredPath.startsWith("~/")) {
        return resolve(homedir(), configuredPath.slice(2));
    }
    return isAbsolute(configuredPath)
        ? resolve(configuredPath)
        : resolve(cwd, configuredPath);
}

export function resolveSandboxPaths(cwd: string, paths: readonly string[]): string[] {
    return [...new Set(paths.map((path) => resolveSandboxPath(cwd, path)))];
}

export function createSandboxRuntimeConfig(
    cwd: string,
    settings: ResolvedSandboxSettings,
    writableRoots: readonly string[] = []
): SandboxRuntimeConfig {
    return {
        filesystem: {
            allowWrite: resolveSandboxPaths(cwd, [".", ...writableRoots]),
            denyRead: resolveSandboxPaths(cwd, settings.filesystem.denyRead),
            denyWrite: resolveSandboxPaths(cwd, [
                ...settings.filesystem.denyWrite,
                ...settings.filesystem.denyRead,
                // Linux mount masks accept literal paths, not Seatbelt-style globs.
                // Existing nested protected paths are discovered before each command.
                ...(process.platform === "linux" ? [".git", ".hicode", ".env"] : MANDATORY_DENY_WRITE),
            ]),
        },
        network: {
            allowedDomains: [...settings.network.allowedDomains],
            deniedDomains: [],
            allowLocalBinding: settings.network.allowLocalBinding,
        },
    };
}
