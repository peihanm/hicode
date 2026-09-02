import {
    SandboxManager,
    type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {createSandboxRuntimeConfig} from "./config.js";
import type {
    ResolvedSandboxSettings,
    SandboxedCommand,
    SandboxPlatform,
    SandboxRuntimeLike,
    SandboxStatus,
} from "./types.js";

interface SandboxBackend {
    isSupportedPlatform(): boolean;
    isSandboxingEnabled(): boolean;
    checkDependencies(): {errors: string[]; warnings: string[]};
    initialize(config: SandboxRuntimeConfig): Promise<void>;
    wrapWithSandboxArgv(
        command: string,
        shell: string | undefined,
        customConfig: undefined,
        signal: AbortSignal,
        cwd: string
    ): Promise<SandboxedCommand>;
    annotateStderrWithSandboxFailures(command: string, stderr: string): string;
    cleanupAfterCommand(): void;
    reset(): Promise<void>;
}

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
    constructor(readonly status: SandboxStatus) {}

    async wrapCommand(): Promise<SandboxedCommand> {
        const reason = this.status.kind === "unavailable"
            ? this.status.reason
            : "Sandbox 未启用";
        throw new Error(reason);
    }

    annotateStderr(_command: string, stderr: string): string {
        return stderr;
    }

    cleanupAfterCommand(): void {}

    async close(): Promise<void> {}
}

class ActiveSandboxRuntime implements SandboxRuntimeLike {
    private closed = false;

    constructor(
        readonly status: Extract<SandboxStatus, {kind: "ready"}>,
        private readonly backend: SandboxBackend,
        private readonly release: () => Promise<void>,
        readonly networkAllowedDomains: readonly string[]
    ) {}

    async wrapCommand(
        command: string,
        cwd: string,
        signal: AbortSignal
    ): Promise<SandboxedCommand> {
        if (this.closed) throw new Error("Sandbox Runtime 已关闭");
        const shell = process.platform === "win32" ? undefined : "/bin/sh";
        return this.backend.wrapWithSandboxArgv(
            command,
            shell,
            undefined,
            signal,
            cwd
        );
    }

    annotateStderr(command: string, stderr: string): string {
        return this.backend.annotateStderrWithSandboxFailures(command, stderr);
    }

    cleanupAfterCommand(): void {
        this.backend.cleanupAfterCommand();
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.release();
    }
}

export function createDisabledSandboxRuntime(): SandboxRuntimeLike {
    return new InactiveSandboxRuntime({kind: "disabled"});
}

export function createSandboxRuntimeFactory(backend: SandboxBackend) {
    let activeLease: symbol | undefined;

    return async function createSandboxRuntime({
        cwd,
        settings,
    }: {
        cwd: string;
        settings: ResolvedSandboxSettings;
    }): Promise<SandboxRuntimeLike> {
        if (!settings.enabled) return createDisabledSandboxRuntime();

        const platform = platformName();
        if (!platform || !backend.isSupportedPlatform()) {
            return new InactiveSandboxRuntime({
                kind: "unavailable",
                reason: `当前平台 ${process.platform} 不支持 OS Sandbox`,
                warnings: [],
            });
        }

        let dependencies;
        try {
            dependencies = backend.checkDependencies();
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
        if (activeLease || backend.isSandboxingEnabled()) {
            return new InactiveSandboxRuntime({
                kind: "unavailable",
                reason: "当前进程已有另一个 Root Runtime 持有 OS Sandbox",
                warnings: dependencies.warnings,
            });
        }

        const lease = Symbol("pillar-sandbox-lease");
        activeLease = lease;
        let released = false;
        const release = async () => {
            if (released || activeLease !== lease) return;
            released = true;
            try {
                await backend.reset();
            } finally {
                if (activeLease === lease) activeLease = undefined;
            }
        };

        try {
            await backend.initialize(createSandboxRuntimeConfig(cwd, settings));
            if (!backend.isSandboxingEnabled()) {
                await release();
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
            }, backend, release, Object.freeze([
                ...settings.network.allowedDomains,
            ]));
        } catch (error) {
            await release().catch(() => undefined);
            return new InactiveSandboxRuntime({
                kind: "unavailable",
                reason: errorMessage(error),
                warnings: dependencies.warnings,
            });
        }
    };
}

export const createSandboxRuntime = createSandboxRuntimeFactory(SandboxManager);
