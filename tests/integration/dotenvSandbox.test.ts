import {expect, test} from "bun:test";
import {lstat, mkdir, readdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {SandboxManager} from "@anthropic-ai/sandbox-runtime";
import {createSandboxRuntime} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {cliTemporaryDirectories} from "../../src/cli/temporaryDirectories.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const enabled = ["linux", "darwin"].includes(process.platform) && process.env.HICODE_RUN_SANDBOX_INTEGRATION === "1";
const missing = async (path: string) => lstat(path).then(() => false, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return true;
    throw error;
});

for (const mode of ["open", "restricted"] as const) {
    test.skipIf(!enabled)(`${mode}: absent dotenv is readable without Bun warnings, protected and cleaned after concurrent commands`, async () => {
        await withTempProject(async (root, storage) => {
            const cwd = join(root, "workspace"); await mkdir(cwd);
            const envFile = join(cwd, ".env");
            await writeFile(join(cwd, "package.json"), '{"name":"offline-dotenv-fixture","private":true}');
            await writeFile(join(cwd, "hold.mjs"), "import {writeFileSync} from 'node:fs';writeFileSync('ready','ok');setInterval(()=>{},1000);");
            const runtime = await createSandboxRuntime({cwd, storage, writableRoots: await cliTemporaryDirectories(), settings: {
                filesystem: {denyRead: [], denyWrite: []}, network: {mode, allowedDomains: [], allowLocalBinding: false},
            }});
            const runner = createShellRunner(runtime, testChildEnvironment);
            const controller = new AbortController();
            let pending: ReturnType<typeof runner.run> | undefined;
            let maskDirectory: string | undefined;
            try {
                expect(runtime.status.kind).toBe("ready");
                const run = (command: string) => runner.run({cwd, command, signal: AbortSignal.timeout(10000)});
                const first = await run("bun install --ignore-scripts");
                expect(first.termination).toMatchObject({kind: "exit", code: 0});
                expect(first.stderr).not.toContain("error loading .env");
                expect(await missing(envFile)).toBe(true);
                pending = runner.run({cwd, command: "node hold.mjs", signal: controller.signal, timeoutMs: 15000});
                const deadline = Date.now() + 5000;
                while (await missing(join(cwd, "ready")) && Date.now() < deadline) await Bun.sleep(10);
                expect(await missing(join(cwd, "ready"))).toBe(false);
                const concurrent = await run("bun install --ignore-scripts");
                expect(concurrent.termination).toMatchObject({kind: "exit", code: 0});
                expect(concurrent.stderr).not.toContain("error loading .env");
                const blocked = await run("printf BAD > .env");
                expect(blocked.termination).toMatchObject({kind: "exit", code: 1});
                if (process.platform === "linux") {
                    maskDirectory = SandboxManager.getMaskedFileStore().dirPath;
                    if (!maskDirectory) throw new Error("No mask source was created");
                    const [entry] = await readdir(maskDirectory);
                    if (!entry) throw new Error("Missing empty file mask");
                    const source = join(maskDirectory, entry);
                    await writeFile(join(cwd, "mask-write.mjs"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(source)},'BAD');`);
                    const tamper = await run("node mask-write.mjs");
                    expect(tamper.termination).toMatchObject({kind: "exit", code: 1});
                    expect(await readFile(source, "utf8")).toBe("");
                }
            } finally {
                controller.abort();
                if (pending) await pending;
                await runtime.close();
            }
            expect(await missing(envFile)).toBe(true);
            if (maskDirectory) expect(await missing(maskDirectory)).toBe(true);
        });
    }, 25000);

    for (const denyRead of [false, true]) test.skipIf(!enabled)(`${mode}: real dotenv content and explicit read denial survive (denyRead=${denyRead})`, async () => {
        await withTempProject(async (cwd, storage) => {
            const path = join(cwd, ".env");
            await writeFile(path, "HICODE_DOTENV_FIXTURE=fixture-value\n");
            await writeFile(join(cwd, "read.mjs"), "import {readFileSync} from 'node:fs';console.log(readFileSync('.env','utf8'));");
            const runtime = await createSandboxRuntime({cwd, storage, settings: {
                filesystem: {denyRead: denyRead ? [path] : [], denyWrite: []}, network: {mode, allowedDomains: [], allowLocalBinding: false},
            }});
            try {
                expect(runtime.status.kind).toBe("ready");
                const runner = createShellRunner(runtime, testChildEnvironment);
                const result = await runner.run({cwd, command: "node read.mjs", signal: AbortSignal.timeout(5000)});
                if (denyRead) expect(result.stdout).not.toContain("fixture-value");
                else expect(result.stdout).toContain("HICODE_DOTENV_FIXTURE=fixture-value");
                const blocked = await runner.run({cwd, command: "printf BAD > .env", signal: AbortSignal.timeout(5000)});
                expect(blocked.termination).toMatchObject({kind: "exit", code: 1});
                expect(await readFile(path, "utf8")).toBe("HICODE_DOTENV_FIXTURE=fixture-value\n");
            } finally {await runtime.close();}
        });
    });
}
