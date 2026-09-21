import type {ResolvedHiCodeSettings} from "../settings/index.js";
import type {NetworkAccessExecution} from "../permissions/networkAccess.js";
import type {ReadOnlyAccess} from "./readOnly.js";

export type ResolvedSandboxSettings = ResolvedHiCodeSettings["sandbox"];
export type SandboxPlatform = "macos" | "linux" | "windows";
export type SandboxExecutionPreference =
    | "use_default"
    | "require_escalated";

export type SandboxStatus =
    | {
        kind: "ready";
        platform: SandboxPlatform;
        networkMode: "restricted" | "open";
        warnings: readonly string[];
    }
    | {
        kind: "unavailable";
        reason: string;
        warnings: readonly string[];
    };

export interface SandboxedCommand {
    argv: string[];
    env: NodeJS.ProcessEnv;
    release?: () => void;
    networkDenials?: readonly string[];
}

export interface SandboxCommandOptions {
    writableRoots?: readonly string[];
    networkAccess?: NetworkAccessExecution;
    readOnlyAccess?: ReadOnlyAccess;
}

export interface SandboxRuntimeLike {
    readonly status: SandboxStatus;

    wrapCommand(
        command: string,
        cwd: string,
        signal: AbortSignal,
        options?: SandboxCommandOptions
    ): Promise<SandboxedCommand>;

    annotateStderr(command: string, stderr: string): string;

    cleanupAfterCommand(): void;

    close(): Promise<void>;
}
