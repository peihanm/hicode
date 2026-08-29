import {SandboxManager} from "@anthropic-ai/sandbox-runtime";
import {createSandboxRuntimeConfig} from "./config.js";
import type {
    ResolvedSandboxSettings,
    SandboxedCommand,
    SandboxPlatform,
    SandboxRuntimeLike,
    SandboxStatus,
} from "./types.js";

function platformName(): SandboxPlatform | undefined {
    if (process.platform === "darwin") return "macos";
    if (process.platform === "linux") return "linux";
    if (process.platform === "win32") return "windows";
    return undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

class InactiveSandboxRuntime implements SandboxRuntimeLike {
    constructor(readonly status: SandboxStatus) {
    }

    async wrapCommand(): Promise<SandboxedCommand> {
        const reason = this.status.kind === "unavailable"
            ? this.status.reason
            : "Sandbox 未启用";
        throw new Error(reason);
    }

    annotateStderr(_command: string, stderr: string): string {
        return stderr;
    }

    cleanupAfterCommand(): void {
    }

    async close(): Promise<void> {
    }
}

class ActiveSandboxRuntime implements SandboxRuntimeLike {
    private closed = false;

    constructor(readonly status: Extract<SandboxStatus, {kind: "ready"}>) {
    }

    async wrapCommand(
        command: string,
        cwd: string,
        signal: AbortSignal
    ): Promise<SandboxedCommand> {
        if (this.closed) throw new Error("Sandbox Runtime 已关闭");
        const shell = process.platform === "win32" ? undefined : "/bin/sh";
        return SandboxManager.wrapWithSandboxArgv(
            command,
            shell,
            undefined,
            signal,
            cwd
        );
    }

    annotateStderr(command: string, stderr: string): string {
        return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
    }

    cleanupAfterCommand(): void {
        SandboxManager.cleanupAfterCommand();
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await SandboxManager.reset();
    }
}

export function createDisabledSandboxRuntime(): SandboxRuntimeLike {
    return new InactiveSandboxRuntime({kind: "disabled"});
}

export async function createSandboxRuntime({
    cwd,
    settings,
}: {
    cwd: string;
    settings: ResolvedSandboxSettings;
}): Promise<SandboxRuntimeLike> {
    if (!settings.enabled) return createDisabledSandboxRuntime();

    const platform = platformName();
    if (!platform || !SandboxManager.isSupportedPlatform()) {
        return new InactiveSandboxRuntime({
            kind: "unavailable",
            reason: `当前平台 ${process.platform} 不支持 OS Sandbox`,
            warnings: [],
        });
    }

    let dependencies;
    try {
        dependencies = SandboxManager.checkDependencies();
    } catch (error) {
        return new InactiveSandboxRuntime({
            kind: "unavailable",
            reason: `Sandbox 依赖检查失败: ${errorMessage(error)}`,
            warnings: [],
        });
    }
    if (dependencies.errors.length > 0) {
        return new InactiveSandboxRuntime({
            kind: "unavailable",
            reason: dependencies.errors.join("；"),
            warnings: dependencies.warnings,
        });
    }

    try {
        await SandboxManager.initialize(
            createSandboxRuntimeConfig(cwd, settings)
        );
        if (!SandboxManager.isSandboxingEnabled()) {
            await SandboxManager.reset();
            return new InactiveSandboxRuntime({
                kind: "unavailable",
                reason: "Sandbox Runtime 初始化后未进入启用状态",
                warnings: dependencies.warnings,
            });
        }
        return new ActiveSandboxRuntime({
            kind: "ready",
            platform,
            warnings: dependencies.warnings,
        });
    } catch (error) {
        await SandboxManager.reset().catch(() => undefined);
        return new InactiveSandboxRuntime({
            kind: "unavailable",
            reason: errorMessage(error),
            warnings: dependencies.warnings,
        });
    }
}
