import {expect, test} from "bun:test";
import {mkdir, readFile, writeFile, realpath} from "node:fs/promises";
import {join} from "node:path";
import {wrapCommandWithSandboxMacOS} from "../../node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import {getDefaultWritePaths} from "@anthropic-ai/sandbox-runtime";
import {createSandboxRuntimeFactory} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {runShellCommand} from "../../src/tools/bash/process.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {getProjectBunCacheDirectory} from "../../src/persistence/layout.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {createTestContext} from "../helpers/testContext.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const enabled = process.env.PILLAR_RUN_SANDBOX_INTEGRATION === "1" && process.platform === "darwin";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

test.skipIf(!enabled)("真实 macOS 沙箱：冷缓存/重复安装无需提权，敏感路径仍禁写", async () => {
    await withTempProject(async (root, storage) => {
        const cwd = join(root, "workspace");
        const pkg = join(root, "package");
        await mkdir(cwd); await mkdir(pkg);
        await writeFile(join(pkg, "package.json"), JSON.stringify({name: "pillar-install-fixture", version: "1.0.0", bin: {"pillar-fixture": "cli.js"}}));
        await writeFile(join(pkg, "cli.js"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
        const archive = join(root, "fixture.tgz");
        const tar = await runShellCommand({cwd: root, signal: new AbortController().signal,
            command: `tar -czf ${quote(archive)} package`});
        expect(tar.termination).toMatchObject({kind: "exit", code: 0});
        await writeFile(join(cwd, "package.json"), JSON.stringify({name: "install-test", dependencies: {"pillar-install-fixture": `file:${archive}`}}));
        await writeFile(join(cwd, "source.ts"), "before");
        await writeFile(join(cwd, ".env"), "fixture=protected");
        // Real Seatbelt enforcement without starting network proxies; this fixture denies all networking.
        let active = false;
        const factory = createSandboxRuntimeFactory({isSupportedPlatform: () => true, isSandboxingEnabled: () => active,
            checkDependencies: () => ({errors: [], warnings: []}), async initialize() {active = true;},
            async wrapWithSandboxArgv(command, shell, config) {
                const wrapped = wrapCommandWithSandboxMacOS({command, binShell: shell, needsNetworkRestriction: true,
                    readConfig: {denyOnly: config?.filesystem?.denyRead ?? []},
                    writeConfig: {allowOnly: [...getDefaultWritePaths(), ...(config?.filesystem?.allowWrite ?? [])],
                        denyWithinAllow: config?.filesystem?.denyWrite ?? []}});
                return {argv: ["/bin/bash", "-c", wrapped], env: {}};
            },
            annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
            cleanupAfterCommand() {}, async reset() {active = false;}});
        const sandbox = await factory({cwd, storage, settings: {enabled: true, filesystem: {denyRead: [], denyWrite: []},
            network: {allowedDomains: [], allowLocalBinding: false}}});
        expect(sandbox.status.kind).toBe("ready");
        const runner = createShellRunner(sandbox, testChildEnvironment);
        const ctx = createTestContext(cwd, {toolResultStore: createTestToolResultStore(cwd, "install", {pillarHome: storage.pillarHome}), shellRunner: runner, canUseTool: async () => {throw new Error("unexpected approval");}});
        try {
            const tools = createToolRuntime();
            expect((await tools.executeTool("write_file", JSON.stringify({path: "tracked.ts", content: "tracked"}), ctx, "write")).outcome).toBe("ok");
            const command = `${quote(process.execPath)} install --ignore-scripts`;
            for (let index = 0; index < 2; index++) {
                const result = await tools.executeTool("bash", JSON.stringify({command}), ctx, `install-${index}`);
                expect(result.modelContent).not.toContain("EPERM");
                expect(result.outcome).toBe("ok");
            }
            const cache = await realpath(getProjectBunCacheDirectory(storage, cwd));
            const env = await runner.run({cwd, signal: ctx.signal, command: 'printf "%s" "$BUN_INSTALL_CACHE_DIR"'});
            expect(env.stdout).toBe(cache);
            const denied = await tools.executeTool("bash", JSON.stringify({command: "printf damaged > .env"}), ctx, "protected");
            expect(denied.outcome).toBe("failed");
            expect(await readFile(join(cwd, ".env"), "utf8")).toBe("fixture=protected");
            expect(await readFile(join(cwd, "source.ts"), "utf8")).toBe("before");
            expect(await Bun.file(join(cwd, "bun.lock")).exists()).toBe(true);
            expect(await Bun.file(join(cwd, "tracked.ts")).exists()).toBe(true);
            expect(await Bun.file(join(cwd, "node_modules/pillar-install-fixture/package.json")).exists()).toBe(true);
        } finally {await sandbox.close();}
    });
}, 20_000);
