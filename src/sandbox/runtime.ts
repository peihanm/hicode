import {bashCommand, bashExecutable} from "../tools/bash/command.js";
import {scopedFileSandboxArgv} from "./readOnly.js";
import {
    SandboxManager,
    getDefaultWritePaths,
    type SandboxRuntimeConfig,
    type SandboxAskCallback,
} from "@anthropic-ai/sandbox-runtime";
import {wrapCommandWithSandboxMacOS} from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import {wrapCommandWithSandboxLinux, getLinuxDependencyStatus, checkLinuxDependencies} from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import {whichSync} from "@anthropic-ai/sandbox-runtime/dist/utils/which.js";
import {runShellArgv} from "../tools/bash/process.js";
import {isAbsolute, relative, resolve} from "node:path";
import {realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {isPathInside} from "../permissions/pathGuard.js";
import {getProjectBunCacheDirectory, getProjectNpmCacheDirectory, type HiCodeStorageLayout} from "../persistence/layout.js";
import {ensurePrivateStorageDirectory} from "../persistence/privateStorage.js";
import {createSandboxRuntimeConfig, resolveSandboxPaths, linuxSandboxTools} from "./config.js";
import {SandboxNetworkApproval} from "./networkApproval.js";
import {linuxFilesystemPolicy, linuxDotEnvMask} from "./linuxPolicy.js";
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
    checkDependencies(tools: Pick<SandboxRuntimeConfig, "bwrapPath" | "socatPath">): {errors: string[]; warnings: string[]};
    initialize(config: SandboxRuntimeConfig, ask: SandboxAskCallback, protectedRoots: readonly string[]): Promise<void>;
    wrapWithSandboxArgv(
        command: string,
        shell: string | undefined,
        customConfig: Partial<SandboxRuntimeConfig> | undefined,
        signal: AbortSignal,
        cwd: string,
        networkMode: "open" | "restricted",
        protectedRoots: readonly string[]
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
        private readonly hicodeHome: string,
        private readonly configuredDenyWrite: readonly string[],
        private readonly protectedRoots: readonly string[]
    ) {}

    async wrapCommand(
        command: string,
        cwd: string,
        signal: AbortSignal,
        options?: SandboxCommandOptions
    ): Promise<SandboxedCommand> {
        if (this.closePromise) throw new Error("Sandbox Runtime is closed");
        if (options?.readOnlyAccess) {
            signal.throwIfAborted();
            return {argv: await scopedFileSandboxArgv(bashCommand(command), options.readOnlyAccess, this.baseConfig.filesystem.denyRead, cwd, undefined, this.baseConfig.bwrapPath), env: {}};
        }
        if (options?.fileWorkspace) {
            const root = await realpath(options.fileWorkspace.root);
            if (!isPathInside(root, await realpath(cwd))) throw new Error("Memory command cwd is outside its file workspace");
            const executables = ["/bin/rm", "/bin/mv", "/bin/cp", "/bin/mkdir", "/bin/ls", "/bin/cat", "/usr/bin/touch", "/usr/bin/sed", "/usr/bin/awk", "/usr/bin/find", "/usr/bin/head", "/usr/bin/tail", "/usr/bin/wc"];
            return {argv: await scopedFileSandboxArgv(bashCommand(command), {
                paths: [], artifacts: [], artifactDirectories: [], deniedPaths: [], privateRoot: this.hicodeHome, executables,
            }, this.baseConfig.filesystem.denyRead, cwd, {root, writable: options.fileWorkspace.writable, deniedWrites: this.configuredDenyWrite}, this.baseConfig.bwrapPath), env: {}};
        }
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
            const temporaryDirectory = await realpath(tmpdir());
            const useStandardTemp = writableRoots.some(root => isPathInside(root, temporaryDirectory));
            // The backend sets TMPDIR inside its shell wrapper, after spawn env.
            // Override it inside the protected command, only with an existing grant.
            const tempCommand = useStandardTemp
                ? `export TMPDIR='${temporaryDirectory.replaceAll("'", "'\\''")}'\n${command}`
                : command;
            const preparedCommand = this.status.platform === "linux" && this.status.networkMode === "restricted"
                ? `export NO_PROXY= no_proxy=\n${tempCommand}` : tempCommand;
            // Keep filesystem policy in the platform wrapper without enabling ASRT's proxy.
            const openConfig = customConfig ?? this.baseConfig;
            const openOptions = {
                command: bashCommand(preparedCommand), binShell: shell,
                needsNetworkRestriction: false,
                readConfig: {denyOnly: this.baseConfig.filesystem.denyRead},
                writeConfig: {
                    allowOnly: [...getDefaultWritePaths(), ...writableRoots],
                    denyWithinAllow: openConfig.filesystem.denyWrite,
                },
            };
            const wrapped = this.status.networkMode === "open" && this.status.platform === "macos"
                ? {argv: [shell, "-c", wrapCommandWithSandboxMacOS(openOptions)], env: {}}
                : await this.backend.wrapWithSandboxArgv(
                    bashCommand(preparedCommand), shell, customConfig, signal, cwd, this.status.networkMode,
                    [...new Set([...this.protectedRoots, ...(options?.writableRoots ?? [])])]
                );
            return {
                ...wrapped,
                env: {
                    ...wrapped.env,
                    ...(this.status.networkMode === "restricted" ? {NODE_USE_ENV_PROXY: "1"} : {}),
                    BUN_INSTALL_CACHE_DIR: this.bunCacheDirectory,
                    npm_config_cache: this.npmCacheDirectory,
                },
                ...approval,
            };
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

        if (settings.network.mode === "open" && platform !== "macos" && platform !== "linux") {
            return new InactiveSandboxRuntime({kind: "unavailable", reason: "Open network with filesystem isolation requires macOS or Linux", warnings: []});
        }
        let dependencies;
        let tools: Pick<SandboxRuntimeConfig, "bwrapPath" | "socatPath"> = {};
        try {
            tools = platform === "linux" ? linuxSandboxTools(process.env.HICODE_LINUX_RUNTIME_DIR) : {};
            dependencies = backend.checkDependencies(tools);
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
            const config = {...createSandboxRuntimeConfig(cwd, settings, [...writableRoots, bunCacheDirectory, npmCacheDirectory]), ...tools};
            if (platform === "linux" && settings.network.allowLocalBinding) {
                config.network.allowedDomains.push("localhost", "127.0.0.1", "[::1]");
            }
            const protectedRoots = resolveSandboxPaths(cwd, [".", ...writableRoots]);
            await backend.initialize(config, networkApproval.ask, protectedRoots);
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
                networkMode: settings.network.mode,
                warnings: dependencies.warnings,
            }, backend, release, config, networkApproval, bunCacheDirectory, npmCacheDirectory, await realpath(storage.hicodeHome), resolveSandboxPaths(cwd, [...settings.filesystem.denyWrite, ...settings.filesystem.denyRead]), protectedRoots);
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

export const createSandboxRuntime = createSandboxRuntimeFactory({
    ...SandboxManager,
    checkDependencies(tools) {
        if (process.platform !== "linux") return SandboxManager.checkDependencies();
        const result = checkLinuxDependencies(tools);
        if (!whichSync("rg")) result.errors.push("ripgrep (rg) not found");
        return result;
    },
    async wrapWithSandboxArgv(command, shell, customConfig, signal, cwd, networkMode, protectedRoots) {
        const base = SandboxManager.getConfig();
        if (process.platform !== "linux") {
            return SandboxManager.wrapWithSandboxArgv(command, shell, customConfig, signal, cwd);
        }
        if (!base) throw new Error("Linux Sandbox configuration is unavailable");
        const config = await linuxFilesystemPolicy({...base, ...customConfig}, signal, protectedRoots);
        const restricted = networkMode === "restricted";
        if (restricted && (!await SandboxManager.waitForNetworkInitialization() ||
            !SandboxManager.getLinuxHttpSocketPath() || !SandboxManager.getLinuxSocksSocketPath())) {
            throw new Error("Linux Sandbox network bridge is unavailable");
        }
        // ASRT launches namespace listeners asynchronously; a fast client can race
        // their bind. This readiness gate belongs to the real proxy backend only.
        const prepared = `(for hicode_bridge_attempt in {1..100}; do
            if ( : > /dev/tcp/127.0.0.1/3128 ) 2>/dev/null && ( : > /dev/tcp/127.0.0.1/1080 ) 2>/dev/null; then exit 0; fi
            /bin/sleep 0.02
          done; printf '%s\\n' 'Linux Sandbox network bridge did not become ready' >&2; exit 125) || exit 125\n${command}`;
        const masks = await linuxDotEnvMask(protectedRoots, SandboxManager.getMaskedFileStore());
        const wrapped = await wrapCommandWithSandboxLinux({
            bwrapPath: config.bwrapPath, socatPath: config.socatPath,
            command: restricted ? prepared : command, binShell: shell, abortSignal: signal,
            needsNetworkRestriction: restricted,
            httpSocketPath: restricted ? SandboxManager.getLinuxHttpSocketPath() : undefined,
            socksSocketPath: restricted ? SandboxManager.getLinuxSocksSocketPath() : undefined,
            httpProxyPort: restricted ? SandboxManager.getProxyPort() : undefined,
            socksProxyPort: restricted ? SandboxManager.getSocksProxyPort() : undefined,
            proxyAuthToken: restricted ? SandboxManager.getProxyAuthToken() : undefined,
            readConfig: {denyOnly: config.filesystem.denyRead},
            writeConfig: {allowOnly: [...getDefaultWritePaths(), ...config.filesystem.allowWrite], denyWithinAllow: config.filesystem.denyWrite},
            ...masks,
        });
        return {argv: [shell ?? bashExecutable(), "-c", wrapped], env: {}};
    },
    async initialize(config, ask, protectedRoots) {
        if (process.platform === "linux" && !getLinuxDependencyStatus().hasSeccompApply) {
            throw new Error("Linux Sandbox requires the bundled apply-seccomp executable (x64 or arm64)");
        }
        const initialConfig = process.platform === "linux"
            ? await linuxFilesystemPolicy(config, AbortSignal.timeout(5000), protectedRoots) : config;
        await SandboxManager.initialize(initialConfig, ask);
        if (process.platform !== "linux") return;
        // Installed binaries do not prove the kernel/container permits nested namespaces.
        // Probe the real wrapper once; never advertise ready and silently run unprotected.
        try {
            const signal = AbortSignal.timeout(5000);
            const cwd = config.filesystem.allowWrite[0] ?? "/";
            const wrapped = await SandboxManager.wrapWithSandboxArgv("/bin/true", bashExecutable(), undefined, signal, cwd);
            const result = await runShellArgv({...wrapped, cwd, signal, timeoutMs: 5000,
                env: {PATH: process.env.PATH, ...wrapped.env}});
            if (result.termination.kind !== "exit" || result.termination.code !== 0) {
                throw new Error(`Linux Sandbox probe failed: ${result.stderr.trim().slice(0, 800) || result.termination.kind}. Check bubblewrap, user namespaces and the container security policy.`);
            }
        } finally {SandboxManager.cleanupAfterCommand();}
    },
});
