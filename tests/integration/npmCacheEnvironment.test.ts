import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {expect, test} from "bun:test";
import {mkdir, readFile, readdir, realpath, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createSandboxRuntimeFactory} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {getProjectNpmCacheDirectory} from "../../src/persistence/layout.js";
import {withTempProject} from "../helpers/tempProject.js";

test("真实 npm 离线安装、嵌套 npx 使用受管缓存，显式 --cache 及非沙箱环境独立", async () => {
    await withTempProject(async (root, storage) => {
        const cwd = join(root, "workspace");
        const home = join(root, "home");
        const pkg = join(root, "package");
        await Promise.all([mkdir(cwd), mkdir(home), mkdir(pkg)]);
        const config = join(root, "empty.npmrc");
        const globalConfig = join(root, "global.npmrc");
        await writeFile(config, ""); await writeFile(globalConfig, "");
        await writeFile(join(pkg, "package.json"), JSON.stringify({name: "hicode-npm-fixture", version: "1.0.0", bin: {"hicode-npm-fixture": "cli.js"}}));
        await writeFile(join(pkg, "cli.js"), "#!/usr/bin/env node\nconsole.log('CACHE=' + process.env.npm_config_cache);\n");
        await writeFile(join(cwd, "package.json"), JSON.stringify({name: "cache-test", version: "1.0.0",
            dependencies: {"hicode-npm-fixture": "file:../fixture.tgz"}, scripts: {nested: "npx --offline hicode-npm-fixture"}}));
        let active = false;
        const sandbox = await createSandboxRuntimeFactory({
            isSupportedPlatform: () => true, isSandboxingEnabled: () => active,
            checkDependencies: () => ({errors: [], warnings: []}),
            async initialize() {active = true;},
            // This fixture tests Runtime -> ShellRunner environment, not OS enforcement.
            async wrapWithSandboxArgv(command) {return {argv: ["/bin/bash", "--noprofile", "--norc", "-c", command], env: {}};},
            annotateStderrWithSandboxFailures: (_command, stderr) => stderr,
            cleanupAfterCommand() {}, async reset() {active = false;},
        })({cwd, storage, settings: {filesystem: {denyRead: [], denyWrite: []}, network: {mode: "restricted", allowedDomains: [], allowLocalBinding: false}}});
        const inheritedCache = join(home, "inherited");
        const environment = createChildProcessEnvironment({PATH: process.env.PATH, HOME: home,
            npm_config_userconfig: config, npm_config_globalconfig: globalConfig, npm_config_update_notifier: "false",
            npm_config_cache: inheritedCache, NPM_CONFIG_CACHE: join(home, "uppercase"), NpM_CoNfIg_CaChE: join(home, "mixed")}, []);
        const runner = createShellRunner(sandbox, environment);
        const signal = new AbortController().signal;
        const run = (command: string) => runner.run({cwd, command, signal, timeoutMs: 10_000});
        try {
            expect(sandbox.status.kind).toBe("ready");
            expect((await run("tar -czf ../fixture.tgz -C .. package")).termination).toMatchObject({kind: "exit", code: 0});
            const installed = await run("npm install --offline --ignore-scripts --no-audit --no-fund");
            expect(installed.termination).toMatchObject({kind: "exit", code: 0});
            const cache = await realpath(getProjectNpmCacheDirectory(storage, cwd));
            expect((await run("npm config get cache")).stdout.trim()).toBe(cache);
            const nested = await run("npm run nested --offline");
            expect(nested.termination).toMatchObject({kind: "exit", code: 0});
            expect(nested.stdout).toContain(`CACHE=${cache}`);
            expect(await readdir(cache)).toContain("_cacache");
            expect((await run("npm config get cache --cache ./explicit-cache")).stdout.trim()).toBe(join(await realpath(cwd), "explicit-cache"));
            for (const local of [createShellRunner(createDisabledSandboxRuntime(), environment), runner]) {
                const elevated = local === runner;
                const result = await local.run({cwd, command: 'printf "%s" "$NPM_CONFIG_CACHE"', signal,
                    ...(elevated ? {sandboxPermissions: "require_escalated" as const} : {})});
                expect(result.stdout).toBe(join(home, "uppercase"));
            }
            expect(await readFile(config, "utf8")).toBe("");
            expect(await readFile(globalConfig, "utf8")).toBe("");
        } finally {await sandbox.close();}
    });
}, 20_000);
