import {expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createSandboxRuntime} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {withTempProject} from "../helpers/tempProject.js";

const enabled = ["darwin", "linux"].includes(process.platform) && process.env.HICODE_RUN_SANDBOX_INTEGRATION === "1";

test.skipIf(!enabled)("sandbox allows real staging/commits but protects configuration and ungranted paths", async () => {
    await withTempProject(async (root, storage) => {
        const cwd = join(root, "repo"); await mkdir(cwd);
        const base = {PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR,
            GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0"};
        const git = (...args: string[]) => execFileSync("git", args, {cwd, env: base, encoding: "utf8"});
        git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
        const originalConfig = await readFile(join(cwd, ".git/config"), "utf8");
        await mkdir(join(cwd, ".hicode"));
        await writeFile(join(cwd, ".env"), "fixture");
        await writeFile(join(root, "outside"), "fixture");
        const env = createChildProcessEnvironment(base, []);
        for (const mode of ["open", "restricted"] as const) {
            const sandbox = await createSandboxRuntime({cwd, storage, settings: {
                filesystem: {denyRead: [], denyWrite: []}, network: {mode, allowedDomains: [], allowLocalBinding: false},
            }});
            expect(sandbox.status.kind).toBe("ready");
            const runner = createShellRunner(sandbox, env);
            const run = (command: string) => runner.run({command, cwd, signal: AbortSignal.timeout(15000)});
            try {
                await writeFile(join(cwd, "source.txt"), mode);
                const result = await run("git add -- source.txt && git commit -m fixture && git diff --exit-code HEAD -- source.txt");
                expect({termination: result.termination, stderr: result.stderr}).toMatchObject({termination: {kind: "exit", code: 0}, stderr: ""});
                expect(git("show", "HEAD:source.txt").trim()).toBe(mode);
                for (const path of [".env", ".hicode/settings.json", ".git/config", ".git/config.lock", ".git/config.worktree", ".git/hooks/pre-commit", "../outside"]) {
                    const denied = await run(`printf BAD > '${path}'`);
                    expect(denied.termination).toMatchObject({kind: "exit", code: 1});
                }
                expect(await readFile(join(cwd, ".git/config"), "utf8")).toBe(originalConfig);
                expect(await readFile(join(root, "outside"), "utf8")).toBe("fixture");
            } finally {await sandbox.close();}
        }
        const sandbox = await createSandboxRuntime({cwd, storage, settings: {
            filesystem: {denyRead: [], denyWrite: [".git"]}, network: {mode: "open", allowedDomains: [], allowLocalBinding: false},
        }});
        try {
            const result = await createShellRunner(sandbox, env).run({command: "git add -- source.txt", cwd, signal: AbortSignal.timeout(15000)});
            expect(result.termination).toMatchObject({kind: "exit", code: 128});
        } finally {await sandbox.close();}
    });
}, 60000);
