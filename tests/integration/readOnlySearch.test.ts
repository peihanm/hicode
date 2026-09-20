import {expect, test} from "bun:test";
import {chmod, mkdir, readFile, realpath, stat, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createSandboxRuntime} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {runShellArgv} from "../../src/tools/bash/process.js";

const enabled = process.platform === "darwin" && process.env.HICODE_RUN_SANDBOX_INTEGRATION === "1";

test.skipIf(!enabled)("real macOS command searches preserve read-only, private results and permissions", async () => {
    await withTempProject(async (cwd, storage) => {
        await mkdir(join(cwd, "src"));
        await mkdir(join(cwd, ".git"));
        await writeFile(join(cwd, ".gitignore"), "*.ignored.ts\n");
        await writeFile(join(cwd, "src", "skip.ignored.ts"), "needle ignored\n");
        await mkdir(join(cwd, "private"));
        await writeFile(join(cwd, "src", "中文 file.ts"), "const needle = 1;\n");
        await writeFile(join(cwd, "private", "secret.txt"), "PRIVATE_NEEDLE\n");
        await symlink(join(cwd, "private"), join(cwd, "src", "alias"));
        const sandbox = await createSandboxRuntime({cwd, storage, settings: {
            filesystem: {denyRead: [join(cwd, "private")], denyWrite: []},
            network: {allowedDomains: [], allowLocalBinding: false},
        }});
        try {
            expect(sandbox.status.kind).toBe("ready");
            const runner = createShellRunner(sandbox, testChildEnvironment);
            let approvals = 0;
            const ctx = createTestContext(cwd, {shellRunner: runner, readOnlyTools: true, workspaceBoundary: "/",
                canUseTool: async () => {approvals++; return {behavior: "deny", message: "Unexpected approval"};}});
            const run = (command: string) => executeToolResult("bash", JSON.stringify({command}), ctx, command);
            const found = await run("rg -n needle src");
            expect(found.outcome).toBe("ok");
            expect(found.modelContent).toContain("中文 file.ts:1:const needle");
            expect(found.modelContent).not.toContain("skip.ignored.ts");
            expect((await run("rg --files -g '*.ts' src")).modelContent).toContain("中文 file.ts");
            const absent = await run("rg -n ABSENT src");
            expect(absent).toMatchObject({outcome: "ok"});
            expect(absent.modelContent).toContain("rg exit code 1");
            expect((await run("rg '[' src")).outcome).toBe("failed");
            expect((await run("rg -L PRIVATE_NEEDLE src")).modelContent).not.toContain("PRIVATE_NEEDLE\n");
            expect((await run("rg secret src; echo bad > changed")).outcome).toBe("denied");
            expect((await run("rg --pre ./run needle src")).outcome).toBe("denied");
            const saved = await ctx.toolResultStore.persistText({toolCallId: "saved", toolName: "bash", content: "ERR_ASSERTION at file.ts:42\n"});
            expect((await run(`rg -n ERR_ASSERTION '${saved.path}'`)).modelContent).toContain("file.ts:42");
            const foreign = createTestContext(cwd, {sessionId: "foreign", shellRunner: runner, readOnlyTools: true});
            expect((await executeToolResult("bash", JSON.stringify({command: `rg ERR_ASSERTION '${saved.path}'`}), foreign, "foreign")).outcome).toBe("denied");
            ctx.permissionRules.deny.push({toolName: "read_file", content: "src/中文 file.ts", source: "local"});
            const denied = await run("rg -n needle src");
            expect(denied.modelContent).not.toContain("const needle");
            ctx.permissionRules.deny = [];
            expect((await executeToolResult("bash", JSON.stringify({command: "rg needle src", sandbox_permissions: "require_escalated"}), ctx, "escalate")).outcome).toBe("denied");
            const startup = join(cwd, "startup.sh");
            await writeFile(startup, "echo STARTUP_INJECTION\n");
            const configuredRunner = createShellRunner(sandbox, createChildProcessEnvironment({...process.env, BASH_ENV: startup, RIPGREP_CONFIG_PATH: startup}, []));
            const configured = await executeToolResult("bash", JSON.stringify({command: "rg needle src"}), createTestContext(cwd, {shellRunner: configuredRunner, readOnlyTools: true}), "config");
            expect(configured.outcome).toBe("ok");
            expect(configured.modelContent).not.toContain("STARTUP_INJECTION");
            await mkdir(join(cwd, "bin"));
            await writeFile(join(cwd, "bin", "rg"), "#!/bin/sh\necho PROJECT_EXECUTED\n");
            await chmod(join(cwd, "bin", "rg"), 0o755);
            const fakeRunner = createShellRunner(sandbox, createChildProcessEnvironment({PATH: `${join(cwd, "bin")}:${process.env.PATH}`}, []));
            const fake = await executeToolResult("bash", JSON.stringify({command: "rg needle .", cwd: "src"}), createTestContext(cwd, {shellRunner: fakeRunner, readOnlyTools: true, workspaceBoundary: "/"}), "fake-program");
            expect(fake.outcome).toBe("failed");
            expect(fake.modelContent).not.toContain("PROJECT_EXECUTED");
            expect(approvals).toBe(0);
            expect(await stat(join(cwd, "changed")).then(() => true, () => false)).toBe(false);
            expect(await readFile(join(cwd, "private", "secret.txt"), "utf8")).toBe("PRIVATE_NEEDLE\n");
            const scope = {paths: [await realpath(cwd)], executables: ["/usr/bin/nc"],
                deniedPaths: [], artifacts: [], privateRoot: await realpath(storage.hicodeHome)};
            // Exercise the OS boundary even when the tool's grammar would reject the command.
            const raw = async (command: string, signal = new AbortController().signal) => {
                const wrapped = await sandbox.wrapCommand(command, await realpath(cwd), signal, {readOnlyAccess: scope});
                return runShellArgv({argv: wrapped.argv, cwd, signal, env: {PATH: "/bin:/usr/bin"}, timeoutMs: 3000});
            };
            const write = await raw("echo bad > forbidden-write");
            expect(write.stderr).toContain("Operation not permitted");
            expect(await stat(join(cwd, "forbidden-write")).then(() => true, () => false)).toBe(false);
            const network = await raw("/usr/bin/nc -zv -w 1 127.0.0.1 9");
            expect(network.stderr).toContain("Operation not permitted");
            const controller = new AbortController();
            const pending = raw("while :; do :; done", controller.signal);
            const timer = setTimeout(() => controller.abort("user-cancel"), 100);
            try {expect((await pending).termination).toMatchObject({kind: "aborted", reason: "user-cancel"});}
            finally {clearTimeout(timer);}
            expect((await run("rg needle src")).outcome).toBe("ok");
        } finally {await sandbox.close();}
    });
}, 30_000);
