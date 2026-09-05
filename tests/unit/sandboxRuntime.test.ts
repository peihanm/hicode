import {describe, expect, test} from "bun:test";
import {createSandboxRuntimeFactory} from "../../src/sandbox/runtime.js";
import type {SandboxRuntimeConfig} from "@anthropic-ai/sandbox-runtime";
import {withTempProject} from "../helpers/tempProject.js";
import {mkdir, realpath} from "node:fs/promises";
import {join} from "node:path";

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
    test("快照 scope 只收窄 allowWrite，保留 denyRead 并禁写排除路径，下一命令不继承", async () => {
        await withTempProject(async cwd => {
            const root = await realpath(cwd);
            const shared = join(root, "shared");
            const project = join(root, "project");
            await mkdir(shared); await mkdir(project);
            const configs: Array<Partial<SandboxRuntimeConfig> | undefined> = [];
            let enabled = false;
            const factory = createSandboxRuntimeFactory({isSupportedPlatform: () => true, isSandboxingEnabled: () => enabled,
                checkDependencies: () => ({errors: [], warnings: []}), async initialize() {enabled = true;},
                async wrapWithSandboxArgv(command, _shell, config) {configs.push(config); return {argv: ["sh", "-c", command], env: {}};},
                annotateStderrWithSandboxFailures: (_command, stderr) => stderr, cleanupAfterCommand() {}, async reset() {}});
            const runtime = await factory({cwd: project, settings: {...settings, filesystem: {denyRead: [join(project, "secret")], denyWrite: []}}});
            try {
                await runtime.wrapCommand("bun test", project, new AbortController().signal, {writableRoots: [shared],
                    filesystemScope: {root: project, denyWrite: [join(project, "node_modules")]}});
                expect(configs[0]?.filesystem?.allowWrite).toEqual([project]);
                expect(configs[0]?.filesystem?.denyRead).toEqual([join(project, "secret")]);
                expect(configs[0]?.filesystem?.denyWrite).toContain(join(project, "node_modules"));
                await runtime.wrapCommand("next", project, new AbortController().signal, {writableRoots: [shared]});
                expect(configs[1]?.filesystem?.allowWrite).toEqual([project, shared]);
                await expect(runtime.wrapCommand("bad", project, new AbortController().signal, {filesystemScope: {root, denyWrite: []}})).rejects.toThrow("收窄");
            } finally {await runtime.close();}
        });
    });
    test("每条命令只获得当前 Session 提供的 writable roots", async () => {
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
        const runtime = await createRuntime({cwd: "/project", settings});

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
            "/shared/session-a",
        ]);
        expect(wrappedConfigs[1]?.filesystem?.allowWrite).toEqual(["/project"]);
        await runtime.close();
    });

    test("同一 Factory 只允许一个 enabled Root 持有全局 Manager", async () => {
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
                enabled = false;
            },
        });

        const firstPromise = createRuntime({cwd: "/project-a", settings});
        const second = await createRuntime({cwd: "/project-b", settings});
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

        const third = await createRuntime({cwd: "/project-c", settings});
        expect(third.status.kind).toBe("ready");
        await third.close();
        expect(resetCount).toBe(2);
    });
});
