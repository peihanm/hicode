import {expect, test} from "bun:test";
import {mkdir, writeFile, readFile} from "node:fs/promises";
import {join} from "node:path";
import {createSandboxRuntime} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {NetworkAccessSession} from "../../src/permissions/networkAccess.js";
import {withTempProject} from "../helpers/tempProject.js";

const enabled = ["darwin", "linux"].includes(process.platform) && process.env.HICODE_RUN_SANDBOX_INTEGRATION === "1";

test.skipIf(!enabled)("Node proxy approval reuse and open network preserve filesystem restrictions", async () => {
    await withTempProject(async (root, storage) => {
        const cwd = join(root, "workspace"); await mkdir(cwd);
        await mkdir(join(cwd, ".git"));
        await writeFile(join(cwd, ".env"), "protected");
        await writeFile(join(cwd, "secret.txt"), "private");
        await writeFile(join(cwd, ".git", "config"), "protected");
        await writeFile(join(root, "outside"), "protected");
        const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("LOCAL_NETWORK_OK")});
        await writeFile(join(cwd, "fetch.mjs"), `try {console.log(await (await fetch('http://127.0.0.1:${server.port}', {signal: AbortSignal.timeout(3000)})).text());} catch(e) { console.error(e.message, e.cause?.code); process.exitCode=1; }`);
        await writeFile(join(cwd, "writes.mjs"), `import {writeFileSync,readFileSync} from 'node:fs';
try {if(readFileSync('secret.txt').length){console.log('UNEXPECTED_READ');process.exitCode=1;} else console.log('READ_DENIED');} catch {console.log('READ_DENIED');}
writeFileSync('ordinary.txt','ok');
for (const path of ['.env','.git/config','../outside']) {
 try {writeFileSync(path,'BAD'); console.log('UNEXPECTED_WRITE',path);process.exitCode=1;} catch {console.log('DENIED',path);}
}`);
        const env = createChildProcessEnvironment({PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR}, []);
        try {
            for (const mode of ["restricted", "open"] as const) {
                const sandbox = await createSandboxRuntime({cwd, storage, settings: {
                    filesystem: {denyRead: ["secret.txt"], denyWrite: []}, network: {mode, allowedDomains: [], allowLocalBinding: false},
                }});
                expect(sandbox.status.kind).toBe("ready");
                const runner = createShellRunner(sandbox, env);
                let approve = false, prompts = 0;
                const session = new NetworkAccessSession();
                const networkAccess = {session, canReview: () => true, canUseTool: async () => {
                    prompts++;
                    return approve ? {behavior: "allow" as const, networkScope: "session" as const}
                        : {behavior: "deny" as const, message: "fixture deny"};
                }};
                const run = (command: string) => runner.run({command, cwd, signal: AbortSignal.timeout(10000), networkAccess});
                try {
                    if (mode === "restricted") {
                        const denied = await run("NO_PROXY= no_proxy= node fetch.mjs");
                        expect(denied.stderr).toContain("network proxy denied");
                        expect(denied.termination).toMatchObject({kind: "exit", code: 1});
                        expect(prompts).toBe(1);
                        approve = true;
                        expect((await run("NO_PROXY= no_proxy= node fetch.mjs")).stdout).toContain("LOCAL_NETWORK_OK");
                        expect(prompts).toBe(2);
                        expect((await run("NO_PROXY= no_proxy= node fetch.mjs")).stdout).toContain("LOCAL_NETWORK_OK");
                        expect(prompts).toBe(2);
                    } else {
                        // Explicitly disable Node proxy support: open mode must work directly.
                        expect((await run("NODE_USE_ENV_PROXY=0 node fetch.mjs")).stdout).toContain("LOCAL_NETWORK_OK");
                        expect(prompts).toBe(0);
                    }
                    const writes = await run("node writes.mjs");
                    expect(writes.termination).toMatchObject({kind: "exit", code: 0});
                    expect(writes.stdout).not.toContain("UNEXPECTED_WRITE");
                    expect(writes.stdout).toContain("READ_DENIED");
                    expect(await readFile(join(cwd, "ordinary.txt"), "utf8")).toBe("ok");
                    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("protected");
                    expect(await readFile(join(cwd, ".git/config"), "utf8")).toBe("protected");
                    expect(await readFile(join(root, "outside"), "utf8")).toBe("protected");
                } finally {await sandbox.close();}
            }
        } finally {server.stop(true);}
    });
}, 30000);
