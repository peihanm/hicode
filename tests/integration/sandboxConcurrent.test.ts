import {expect, test} from "bun:test";
import {mkdir, readdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createSandboxRuntime} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const enabled = ["darwin", "linux"].includes(process.platform) && process.env.HICODE_RUN_SANDBOX_INTEGRATION === "1";

for (const mode of ["open", "restricted"] as const) test.skipIf(!enabled)(`${mode}: live Node service and repeated foreground commands preserve protected paths`, async () => {
    await withTempProject(async (cwd, storage) => {
        const nested = join(cwd, "nested");
        await mkdir(join(nested, ".git"), {recursive: true});
        await mkdir(join(nested, ".hicode"));
        const protectedPaths = ["nested/.git/config", "nested/.hicode/settings.json", "nested/.env.production"];
        for (const path of protectedPaths) await writeFile(join(cwd, path), "protected");
        await writeFile(join(cwd, "server.mjs"), `import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
const server=createServer((req,res)=>res.end('ok'));
server.listen(0,'127.0.0.1',()=>writeFileSync('ready.txt','ready'));`);
        await writeFile(join(cwd, "check.mjs"), `import {writeFileSync} from 'node:fs';
for (const path of ${JSON.stringify(protectedPaths)}) {
 let denied=false; try {writeFileSync(path,'BAD');} catch {denied=true;}
 if(!denied) throw new Error('write was allowed: '+path);
}
writeFileSync('ordinary.txt','ok'); console.log('CHECK_OK');`);
        const runtime = await createSandboxRuntime({cwd, storage, settings: {
            filesystem: {denyRead: [], denyWrite: []}, network: {mode, allowedDomains: [], allowLocalBinding: true},
        }});
        const controller = new AbortController();
        const runner = createShellRunner(runtime, testChildEnvironment);
        let service: ReturnType<typeof runner.run> | undefined;
        try {
            expect(runtime.status.kind).toBe("ready");
            service = runner.run({cwd, command: "node server.mjs", signal: controller.signal, timeoutMs: 10000});
            const deadline = Date.now() + 5000;
            while (!(await Bun.file(join(cwd, "ready.txt")).exists()) && Date.now() < deadline) {
                await Bun.sleep(20);
            }
            expect(await Bun.file(join(cwd, "ready.txt")).text()).toBe("ready");
            for (let index = 0; index < 4; index++) {
                const result = await runner.run({cwd, command: "pwd && node --version && node check.mjs", signal: AbortSignal.timeout(5000)});
                expect(result.stderr).toBe("");
                expect(result.termination).toMatchObject({kind: "exit", code: 0});
                expect(result.stdout).toContain("CHECK_OK");
            }
            for (const path of protectedPaths) expect(await readFile(join(cwd, path), "utf8")).toBe("protected");
            expect(await readdir(cwd)).not.toContain("**");
            expect(await readdir(cwd)).not.toContain(".env*");
        } finally {
            controller.abort();
            if (service) await service;
            await runtime.close();
        }
        expect(await readdir(cwd)).not.toContain("**");
    });
}, 20000);
