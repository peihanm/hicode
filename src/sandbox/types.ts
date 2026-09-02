import type {ResolvedPillarSettings} from "../settings/index.js";

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
}

export interface SandboxRuntimeLike {
    readonly status: SandboxStatus;
    readonly networkAllowedDomains?: readonly string[];

    wrapCommand(
        command: string,
        cwd: string,
        signal: AbortSignal
    ): Promise<SandboxedCommand>;

    annotateStderr(command: string, stderr: string): string;

    cleanupAfterCommand(): void;

    close(): Promise<void>;
}
