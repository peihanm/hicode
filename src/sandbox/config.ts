import {homedir} from "node:os";
import {isAbsolute, resolve} from "node:path";
import type {SandboxRuntimeConfig} from "@anthropic-ai/sandbox-runtime";
import type {ResolvedSandboxSettings} from "./types.js";

const MANDATORY_DENY_WRITE = [".pillar", ".env"];

function resolveSandboxPath(cwd: string, configuredPath: string): string {
    if (configuredPath === "~") return homedir();
    if (configuredPath.startsWith("~/")) {
        return resolve(homedir(), configuredPath.slice(2));
    }
    return isAbsolute(configuredPath)
        ? resolve(configuredPath)
        : resolve(cwd, configuredPath);
}

function resolveUniquePaths(cwd: string, paths: readonly string[]): string[] {
    return [...new Set(paths.map((path) => resolveSandboxPath(cwd, path)))];
}

export function createSandboxRuntimeConfig(
    cwd: string,
    settings: ResolvedSandboxSettings
): SandboxRuntimeConfig {
    return {
        filesystem: {
            allowWrite: resolveUniquePaths(cwd, settings.filesystem.allowWrite),
            denyRead: resolveUniquePaths(cwd, settings.filesystem.denyRead),
            denyWrite: resolveUniquePaths(cwd, [
                ...settings.filesystem.denyWrite,
                ...MANDATORY_DENY_WRITE,
            ]),
        },
        network: {
            allowedDomains: [...settings.network.allowedDomains],
            deniedDomains: [],
            allowLocalBinding: settings.network.allowLocalBinding,
        },
    };
}
