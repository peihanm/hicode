import {describe, expect, test} from "bun:test";
import {createSandboxRuntimeFactory} from "../../src/sandbox/runtime.js";
import type {SandboxRuntimeConfig} from "@anthropic-ai/sandbox-runtime";

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
