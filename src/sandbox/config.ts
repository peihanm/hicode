import {homedir} from "node:os";
import {isAbsolute, resolve} from "node:path";
import type {SandboxRuntimeConfig} from "@anthropic-ai/sandbox-runtime";
import type {ResolvedSandboxSettings} from "./types.js";
import {whichSync} from "@anthropic-ai/sandbox-runtime/dist/utils/which.js";

/** The installer supplies a versioned directory; SDK/source users may use system tools. */
export function linuxSandboxTools(directory: string | undefined): Pick<SandboxRuntimeConfig, "bwrapPath" | "socatPath"> {
    if (directory !== undefined) {
        if (!isAbsolute(directory) || /[\0\r\n]/.test(directory)) throw new Error("HICODE_LINUX_RUNTIME_DIR must be an absolute directory");
        return {bwrapPath: resolve(directory, "bin/bwrap"), socatPath: resolve(directory, "bin/socat")};
    }
    return {bwrapPath: whichSync("bwrap") ?? undefined, socatPath: whichSync("socat") ?? undefined};
}

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
