import {describe, expect, test} from "bun:test";
import {createSandboxRuntimeFactory} from "../../src/sandbox/runtime.js";

const settings = {
    enabled: true,
    filesystem: {
        allowWrite: ["."],
        denyRead: [],
        denyWrite: [],
    },
    network: {
        allowedDomains: [],
        allowLocalBinding: false,
    },
};

describe("Sandbox Runtime lease", () => {
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
