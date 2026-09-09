import {describe, expect, test} from "bun:test";
import {createSandboxRuntimeFactory} from "../../src/sandbox/runtime.js";
import type {SandboxRuntimeConfig} from "@anthropic-ai/sandbox-runtime";
import {withTempProject} from "../helpers/tempProject.js";
import {mkdir, realpath} from "node:fs/promises";
import {join} from "node:path";
import {execFileSync} from "node:child_process";

const settings = {
    enabled: true,
    filesystem: {
        denyRead: [],
        denyWrite: [],
    },
    network: {
        allowedDomains: [],
        allowLocalBinding: false,
    },
};

describe("Sandbox Runtime lease", () => {
    test("安全路径保护独立生效，额外目录授权不移除 denyRead/denyWrite", async () => {
        await withTempProject(async (root, storage) => {
            const project = join(root, "project"); await mkdir(project);
            const configs: Array<Partial<SandboxRuntimeConfig> | undefined> = [];
            let active = false;
            const factory = createSandboxRuntimeFactory({
                isSupportedPlatform: () => true, isSandboxingEnabled: () => active,
                checkDependencies: () => ({errors: [], warnings: []}),
                async initialize() {active = true;},
                async wrapWithSandboxArgv(_command, _shell, config) {configs.push(config); return {argv: ["true"], env: {}};},
                annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
                cleanupAfterCommand() {}, async reset() {active = false;},
            });
            const runtime = await factory({cwd: project, storage, settings: {...settings, filesystem: {denyRead: [join(project, "secret")], denyWrite: []}}});
            try {
                await runtime.wrapCommand("test", project, new AbortController().signal, {writableRoots: [root]});
                expect(configs[0]?.filesystem?.allowWrite).toContain(root);
                expect(configs[0]?.filesystem?.denyWrite).toContain(join(project, ".git"));
                expect(configs[0]?.filesystem?.denyWrite).toContain(join(project, "secret"));
                expect(configs[0]?.filesystem?.denyRead).toContain(join(project, "secret"));
            } finally {await runtime.close();}
        });
    });

    test("每条命令只获得当前 Session 提供的 writable roots", async () => {
      await withTempProject(async (_cwd, storage) => {
        let enabled = false;
        const wrappedConfigs: Array<Partial<SandboxRuntimeConfig> | undefined> = [];
        const createRuntime = createSandboxRuntimeFactory({
            isSupportedPlatform: () => true,
            isSandboxingEnabled: () => enabled,
            checkDependencies: () => ({errors: [], warnings: []}),
            async initialize() {
                enabled = true;
            },
            async wrapWithSandboxArgv(command, _shell, customConfig) {
                wrappedConfigs.push(customConfig);
                return {argv: ["sh", "-c", command], env: {}};
            },
            annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
            cleanupAfterCommand() {},
            async reset() {
                enabled = false;
            },
        });
        const runtime = await createRuntime({storage, cwd: "/project", settings});

        await runtime.wrapCommand(
            "first",
            "/project",
            new AbortController().signal,
            {writableRoots: ["/shared/session-a"]}
        );
        await runtime.wrapCommand(
            "second",
            "/project",
            new AbortController().signal
        );

        expect(wrappedConfigs[0]?.filesystem?.allowWrite).toEqual([
            "/project",
            expect.stringContaining("/cache/bun"),
            expect.stringContaining("/cache/npm"),
            "/shared/session-a",
        ]);
        expect(wrappedConfigs[1]?.filesystem?.allowWrite).toEqual(["/project", expect.stringContaining("/cache/bun"), expect.stringContaining("/cache/npm")]);
        await runtime.close();
      });
    });

    test("同一 Factory 只允许一个 enabled Root 持有全局 Manager", async () => {
      await withTempProject(async (_cwd, storage) => {
        let enabled = false;
        let finishInitialization: (() => void) | undefined;
        let resetCount = 0;
        const initialization = new Promise<void>((resolve) => {
            finishInitialization = resolve;
        });
        const createRuntime = createSandboxRuntimeFactory({
            isSupportedPlatform: () => true,
            isSandboxingEnabled: () => enabled,
            checkDependencies: () => ({errors: [], warnings: []}),
            async initialize() {
                await initialization;
                enabled = true;
            },
            async wrapWithSandboxArgv(command) {
                return {argv: ["sh", "-c", command], env: {}};
            },
            annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
            cleanupAfterCommand() {},
            async reset() {
                resetCount += 1;
                // Real sandbox-runtime retains config, so this flag stays true after reset.
            },
        });

        const firstPromise = createRuntime({storage, cwd: "/project-a", settings});
        const second = await createRuntime({storage, cwd: "/project-b", settings});
        expect(second.status).toMatchObject({
            kind: "unavailable",
            reason: expect.stringContaining("另一个 Root Runtime"),
        });

        finishInitialization?.();
        const first = await firstPromise;
        expect(first.status.kind).toBe("ready");
        await second.close();
        expect(resetCount).toBe(0);
        await first.close();
        await first.close();
        expect(resetCount).toBe(1);

        const third = await createRuntime({storage, cwd: "/project-c", settings});
        expect(third.status.kind).toBe("ready");
        await third.close();
        expect(resetCount).toBe(2);
      });
    });
});

test("真实依赖的 reset 保留 enabled 标记，不可用作活动 owner 判断", () => {
    const output = execFileSync(process.execPath, ["-e", `
        import {SandboxManager} from "@anthropic-ai/sandbox-runtime";
        const before = SandboxManager.isSandboxingEnabled();
        SandboxManager.updateConfig({filesystem:{denyRead:[],allowWrite:[],denyWrite:[]},network:{allowedDomains:[],deniedDomains:[]}});
        await SandboxManager.reset();
        process.stdout.write(JSON.stringify({before, after:SandboxManager.isSandboxingEnabled()}));
    `], {encoding: "utf8", timeout: 10_000, env: {PATH: process.env.PATH ?? ""}});
    expect(JSON.parse(output)).toEqual({before: false, after: true});
});

test("关闭等待 reset 完成，清理失败后禁止新 Root 接管", async () => {
    await withTempProject(async (cwd, storage) => {
        let configured = false, resets = 0;
        let rejectReset!: (error: Error) => void;
        const resetGate = new Promise<void>((_, reject) => {rejectReset = reject;});
        const factory = createSandboxRuntimeFactory({
            isSupportedPlatform: () => true, isSandboxingEnabled: () => configured,
            checkDependencies: () => ({errors: [], warnings: []}),
            async initialize() {configured = true;},
            async wrapWithSandboxArgv() {return {argv: ["true"], env: {}};},
            annotateStderrWithSandboxFailures: (_, stderr) => stderr, cleanupAfterCommand() {},
            async reset() {resets++; await resetGate;},
        });
        const first = await factory({cwd, storage, settings});
        expect(first.status.kind).toBe("ready");
        const closing = first.close();
        expect(first.close() === closing).toBe(true);
        expect((await factory({cwd, storage, settings})).status).toMatchObject({kind: "unavailable", reason: expect.stringContaining("另一个 Root")});
        await expect(first.wrapCommand("true", cwd, new AbortController().signal)).rejects.toThrow("已关闭");
        const outcome = closing.catch(error => error);
        rejectReset(new Error("reset failed"));
        expect(await outcome).toMatchObject({message: "reset failed"});
        expect((await factory({cwd, storage, settings})).status).toMatchObject({kind: "unavailable", reason: expect.stringContaining("清理失败")});
        expect(resets).toBe(1);
    });
});

test("初始化失败但 reset 成功后可重试，未知外部 owner 仍不能接管", async () => {
    await withTempProject(async (cwd, storage) => {
        let configured = true, starts = 0, resets = 0;
        const factory = createSandboxRuntimeFactory({
            isSupportedPlatform: () => true, isSandboxingEnabled: () => configured,
            checkDependencies: () => ({errors: [], warnings: []}),
            async initialize() {configured = true; if (++starts === 1) throw new Error("partial init");},
            async wrapWithSandboxArgv() {return {argv: ["true"], env: {}};},
            annotateStderrWithSandboxFailures: (_, stderr) => stderr, cleanupAfterCommand() {},
            async reset() {resets++;},
        });
        expect((await factory({cwd, storage, settings})).status.kind).toBe("unavailable");
        expect(starts).toBe(0); expect(resets).toBe(0);
        configured = false;
        expect((await factory({cwd, storage, settings})).status).toMatchObject({kind: "unavailable", reason: "partial init"});
        expect(configured).toBe(true); expect(resets).toBe(1);
        const recovered = await factory({cwd, storage, settings});
        expect(recovered.status.kind).toBe("ready");
        await recovered.close();
        expect(resets).toBe(2);
    });
});

test.each(["bun", "npm"] as const)("受管 %s 缓存拒绝 symlink，初始化失败释放 lease，显式禁写仍保留", async manager => {
    await withTempProject(async (cwd, storage) => {
        const {getProjectBunCacheDirectory, getProjectNpmCacheDirectory} = await import("../../src/persistence/layout.js");
        const {ensurePrivateStorageDirectory} = await import("../../src/persistence/privateStorage.js");
        const {dirname} = await import("node:path");
        const {symlink, unlink} = await import("node:fs/promises");
        const cache = (manager === "bun" ? getProjectBunCacheDirectory : getProjectNpmCacheDirectory)(storage, cwd);
        ensurePrivateStorageDirectory(storage, dirname(cache));
        const outside = join(cwd, "outside");
        await mkdir(outside);
        await symlink(outside, cache);
        let active = false;
        let resets = 0;
        const configs: Array<Partial<SandboxRuntimeConfig> | undefined> = [];
        const factory = createSandboxRuntimeFactory({isSupportedPlatform: () => true, isSandboxingEnabled: () => active,
            checkDependencies: () => ({errors: [], warnings: []}), async initialize() {active = true;},
            async wrapWithSandboxArgv(command, _shell, config) {configs.push(config); return {argv: ["sh", "-c", command], env: {BUN_INSTALL_CACHE_DIR: "/untrusted-cache"}};},
            annotateStderrWithSandboxFailures: (_command, stderr) => stderr, cleanupAfterCommand() {},
            async reset() {active = false; resets++;}});
        const rejected = await factory({cwd, storage, settings});
        expect(rejected.status).toMatchObject({kind: "unavailable", reason: expect.stringContaining("不安全")});
        expect(resets).toBe(1);
        await unlink(cache);
        const runtime = await factory({cwd, storage, settings: {...settings, filesystem: {denyRead: [], denyWrite: [cache]}}});
        try {
            expect(runtime.status.kind).toBe("ready");
            const wrapped = await runtime.wrapCommand("install", cwd, new AbortController().signal);
            expect(wrapped.env[manager === "bun" ? "BUN_INSTALL_CACHE_DIR" : "npm_config_cache"]).toBe(await realpath(cache));
            expect(configs[0]?.filesystem?.denyWrite).toContain(cache);
            expect(configs[0]?.filesystem?.allowWrite).not.toContain(storage.pillarHome);
        } finally {await runtime.close();}
        expect(resets).toBe(2);
    });
});
