import {bashCommand, bashExecutable} from "../tools/bash/command.js";
import {
    SandboxManager,
    type SandboxRuntimeConfig,
    type SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";
import {isAbsolute, relative, resolve} from "node:path";
import {realpath} from "node:fs/promises";
import {getProjectBunCacheDirectory, getProjectNpmCacheDirectory, type HiCodeStorageLayout} from "../persistence/layout.js";
import {ensurePrivateStorageDirectory} from "../persistence/privateStorage.js";
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
            : "Sandbox is not enabled";
        throw new Error(reason);
    }

    annotateStderr(_command: string, stderr: string): string {
        return stderr;
    }

    cleanupAfterCommand(): void {}

    async close(): Promise<void> {}
}

class ActiveSandboxRuntime implements SandboxRuntimeLike {
    private closePromise: Promise<void> | undefined;

    constructor(
        readonly status: Extract<SandboxStatus, {kind: "ready"}>,
        private readonly backend: SandboxBackend,
        private readonly release: () => Promise<void>,
        private readonly baseConfig: SandboxRuntimeConfig,
        private readonly networkApproval: SandboxNetworkApproval,
        private readonly bunCacheDirectory: string,
        private readonly npmCacheDirectory: string,
        private readonly hicodeHome: string
    ) {}

    async wrapCommand(
        command: string,
        cwd: string,
        signal: AbortSignal,
        options?: SandboxCommandOptions
    ): Promise<SandboxedCommand> {
        if (this.closePromise) throw new Error("Sandbox Runtime is closed");
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
            throw new Error("Windows Sandbox does not support adding writable roots dynamically within a Session");
        }
        const customConfig = writableRoots.length === 0
            ? undefined
            : {
                ...this.baseConfig,
                filesystem: {
                    ...this.baseConfig.filesystem,
                    allowWrite: writableRoots,
                },
            };
        // The private store cannot become writable through a broad workspace grant.
        const within = (parent: string, path: string) => {
            const part = relative(parent, path);
            return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"));
        };
        if (customConfig && writableRoots.some(root => within(root, this.hicodeHome))) {
            customConfig.filesystem.denyWrite = [...customConfig.filesystem.denyWrite, this.hicodeHome];
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
            return {...wrapped, env: {...wrapped.env, BUN_INSTALL_CACHE_DIR: this.bunCacheDirectory, npm_config_cache: this.npmCacheDirectory}, ...approval};
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

    close(): Promise<void> {
        this.closePromise ??= this.release();
        return this.closePromise;
    }
}

export function createSandboxRuntimeFactory(backend: SandboxBackend) {
    let ownership: {kind: "unclaimed"} | {kind: "idle"} | {kind: "owned"; lease: symbol} | {kind: "failed"; reason: string} = {kind: "unclaimed"};

    return async function createSandboxRuntime({
        cwd,
        storage,
        settings,
        writableRoots = [],
    }: {
        cwd: string;
        storage: HiCodeStorageLayout;
        settings: ResolvedSandboxSettings;
        writableRoots?: readonly string[];
    }): Promise<SandboxRuntimeLike> {

        const platform = platformName();
        if (!platform || !backend.isSupportedPlatform()) {
            return new InactiveSandboxRuntime({
                kind: "unavailable",
                reason: `Current platform ${process.platform} does not support OS Sandbox`,
                warnings: [],
            });
        }

        let dependencies;
        try {
            dependencies = backend.checkDependencies();
        } catch (error) {
            return new InactiveSandboxRuntime({
                kind: "unavailable",
                reason: `Sandbox dependency check failed: ${errorMessage(error)}`,
                warnings: [],
            });
        }
        if (dependencies.errors.length > 0) {
            return new InactiveSandboxRuntime({
                kind: "unavailable",
                reason: dependencies.errors.join(";"),
                warnings: dependencies.warnings,
            });
        }
        if (ownership.kind === "failed") {
            return new InactiveSandboxRuntime({kind: "unavailable", reason: ownership.reason, warnings: dependencies.warnings});
        }
        // The backend's enabled flag means "config exists", even after a successful reset.
        // Only our completed release proves it is safe to acquire that configured backend again.
        if (ownership.kind === "owned" || (ownership.kind === "unclaimed" && backend.isSandboxingEnabled())) {
            return new InactiveSandboxRuntime({
                kind: "unavailable",
                reason: "Another Root Runtime in this process already owns the OS Sandbox",
                warnings: dependencies.warnings,
            });
        }

        const lease = Symbol("hicode-sandbox-lease");
        const networkApproval = new SandboxNetworkApproval();
        ownership = {kind: "owned", lease};
        let releasePromise: Promise<void> | undefined;
        const release = async () => {
            releasePromise ??= (async () => {
                if (ownership.kind !== "owned" || ownership.lease !== lease) return;
                networkApproval.close();
                try {
                    await backend.reset();
                    ownership = {kind: "idle"};
                } catch (error) {
                    ownership = {kind: "failed", reason: `Sandbox cleanup failed; restart HiCode: ${errorMessage(error)}`};
                    throw error;
                }
            })();
            return releasePromise;
        };

        try {
            const cachePath = getProjectBunCacheDirectory(storage, cwd);
            ensurePrivateStorageDirectory(storage, cachePath);
            const bunCacheDirectory = await realpath(cachePath);
            const npmCachePath = getProjectNpmCacheDirectory(storage, cwd);
            ensurePrivateStorageDirectory(storage, npmCachePath);
            const npmCacheDirectory = await realpath(npmCachePath);
            const config = createSandboxRuntimeConfig(cwd, settings, [...writableRoots, bunCacheDirectory, npmCacheDirectory]);
            await backend.initialize(config, networkApproval.ask);
            if (!backend.isSandboxingEnabled()) {
                await release();
                return new InactiveSandboxRuntime({
                    kind: "unavailable",
                    reason: "Sandbox Runtime did not become enabled after initialization",
                    warnings: dependencies.warnings,
                });
            }
            return new ActiveSandboxRuntime({
                kind: "ready",
                platform,
                warnings: dependencies.warnings,
            }, backend, release, config, networkApproval, bunCacheDirectory, npmCacheDirectory, await realpath(storage.hicodeHome));
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
