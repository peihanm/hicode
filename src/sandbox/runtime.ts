import {bashCommand, bashExecutable} from "../tools/bash/command.js";
import {
    SandboxManager,
    type SandboxRuntimeConfig,
    type SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";
import {isAbsolute, relative, resolve} from "node:path";
import {realpath} from "node:fs/promises";
import {createSandboxRuntimeConfig} from "./config.js";
import {SandboxNetworkApproval} from "./networkApproval.js";
import type {
    ResolvedSandboxSettings,
    SandboxedCommand,
    SandboxPlatform,
    SandboxRuntimeLike,
    SandboxStatus,
    SandboxCommandOptions,
} from "./types.js";

interface SandboxBackend {
    isSupportedPlatform(): boolean;
    isSandboxingEnabled(): boolean;
    checkDependencies(): {errors: string[]; warnings: string[]};
    initialize(config: SandboxRuntimeConfig, ask?: SandboxAskCallback): Promise<void>;
    wrapWithSandboxArgv(
        command: string,
        shell: string | undefined,
        customConfig: Partial<SandboxRuntimeConfig> | undefined,
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
        private readonly baseConfig: SandboxRuntimeConfig,
        private readonly networkApproval: SandboxNetworkApproval
    ) {}

    async wrapCommand(
        command: string,
        cwd: string,
        signal: AbortSignal,
        options?: SandboxCommandOptions
    ): Promise<SandboxedCommand> {
        if (this.closed) throw new Error("Sandbox Runtime 已关闭");
        const shell = bashExecutable();
        const baseWritableRoots = this.baseConfig.filesystem.allowWrite
            .map((path) => resolve(path));
        const writableRoots = [...new Set([
            ...baseWritableRoots,
            ...(options?.writableRoots ?? []).map((path) => resolve(path)),
        ])];
        if (
            this.status.platform === "windows" &&
            writableRoots.some((path) => !baseWritableRoots.includes(path))
        ) {
            throw new Error("Windows Sandbox 不支持在 Session 中动态增加 writable root");
        }
        let customConfig = writableRoots.length === 0
            ? undefined
            : {
                ...this.baseConfig,
                filesystem: {
                    ...this.baseConfig.filesystem,
                    allowWrite: writableRoots,
                },
            };
        if (options?.filesystemScope) {
            if (this.status.platform === "windows") throw new Error("Windows 不支持逐命令工作区快照写边界");
            const scope = options.filesystemScope;
            const root = await realpath(scope.root);
            const allowed = await Promise.all(writableRoots.map(path => realpath(path)));
            const within = (parent: string, path: string) => {
                const part = relative(parent, path);
                return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"));
            };
            if (!allowed.some(parent => within(parent, root)) || scope.denyWrite.some(path => !isAbsolute(path) || !within(root, resolve(path)))) {
                throw new Error("Shell 快照写边界必须收窄已有目录授权");
            }
            customConfig = {...this.baseConfig, filesystem: {...this.baseConfig.filesystem,
                allowWrite: [root], denyWrite: [...this.baseConfig.filesystem.denyWrite, ...scope.denyWrite]}};
        }
        const approval = this.networkApproval.register(options?.networkAccess, signal);
        try {
            const wrapped = await this.backend.wrapWithSandboxArgv(
                bashCommand(command),
                shell,
                customConfig,
                signal,
                cwd
            );
            return {...wrapped, ...approval};
        } catch (error) {
            approval.release();
            throw error;
        }
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
        this.networkApproval.close();
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
        writableRoots = [],
    }: {
        cwd: string;
        settings: ResolvedSandboxSettings;
        writableRoots?: readonly string[];
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
        const networkApproval = new SandboxNetworkApproval();
        activeLease = lease;
        let released = false;
        const release = async () => {
            if (released || activeLease !== lease) return;
            released = true;
            networkApproval.close();
            try {
                await backend.reset();
            } finally {
                if (activeLease === lease) activeLease = undefined;
            }
        };

        try {
            const config = createSandboxRuntimeConfig(cwd, settings, writableRoots);
            await backend.initialize(config, networkApproval.ask);
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
            }, backend, release, config, networkApproval);
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
