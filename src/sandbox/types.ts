import type {ResolvedPillarSettings} from "../settings/index.js";
import type {NetworkAccessExecution} from "../permissions/networkAccess.js";

export type ResolvedSandboxSettings = ResolvedPillarSettings["sandbox"];
export type SandboxPlatform = "macos" | "linux" | "windows";
export type SandboxExecutionPreference =
    | "use_default"
    | "require_escalated";

export type SandboxStatus =
    | {kind: "disabled"}
    | {
        kind: "ready";
        platform: SandboxPlatform;
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
