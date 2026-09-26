import {expect, test} from "bun:test";
import {mkdir, readFile, stat, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createSandboxRuntime} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {loadHiCodeSettings} from "../../src/settings/index.js";

const enabled = ["darwin", "linux"].includes(process.platform) && process.env.HICODE_RUN_SANDBOX_INTEGRATION === "1";

test.skipIf(!enabled)("Memory file scope permits owned writes but hides other private data and denies escapes", async () => {
    await withTempProject(async (cwd, storage) => {
        const root = join(storage.hicodeHome, "topics");
        const secret = join(storage.hicodeHome, "secret");
        const protectedFile = join(root, "protected.md");
        await mkdir(root, {recursive: true});
        await writeFile(secret, "PRIVATE_VALUE");
        await writeFile(protectedFile, "protected");
        await symlink(secret, join(root, "escape"));
        const sandbox = await createSandboxRuntime({cwd, storage, settings: {
            filesystem: {denyRead: [], denyWrite: [protectedFile, secret]},
            network: {mode: "open", allowedDomains: [], allowLocalBinding: false},
        }});
        try {
            expect(sandbox.status).toMatchObject({kind: "ready"});
            const runner = createShellRunner(sandbox, testChildEnvironment);
            const run = (command: string, writable = true) => runner.run({command, cwd: root,
                signal: AbortSignal.timeout(5000), fileWorkspace: {root, writable}});
            const written = await run("printf hello > note.md && /bin/cat note.md");
            expect(written.stderr).toBe("");
            expect(written.stdout).toBe("hello");
            for (const command of ["printf bad > ../secret", "printf bad > protected.md", "printf bad > escape"]) {
                const result = await run(command);
                expect(result.termination).toMatchObject({kind: "exit"});
                expect(result.termination).not.toMatchObject({code: 0});
            }
            expect((await run("/bin/cat ../secret escape")).stdout).not.toContain("PRIVATE_VALUE");
            expect((await run("printf bad > note.md", false)).termination).not.toMatchObject({code: 0});
            expect(await readFile(join(root, "note.md"), "utf8")).toBe("hello");
            expect(await readFile(secret, "utf8")).toBe("PRIVATE_VALUE");
            expect(await readFile(protectedFile, "utf8")).toBe("protected");
            expect((await run("/bin/rm -rf .")).termination).not.toMatchObject({code: 0});
            expect((await stat(root)).isDirectory()).toBe(true);
            expect((await run("/bin/rm note.md")).termination).toMatchObject({kind: "exit", code: 0});
        } finally {await sandbox.close();}
    });
}, 15000);

test.skipIf(!enabled || process.platform !== "linux")("Linux refuses unsupported read globs without leaving the backend leased", async () => {
    await withTempProject(async (cwd, storage) => {
        const settings = {filesystem: {denyRead: ["**/secret"], denyWrite: []},
            network: {mode: "open" as const, allowedDomains: [], allowLocalBinding: false}};
        const rejected = await createSandboxRuntime({cwd, storage, settings});
        expect(rejected.status).toMatchObject({kind: "unavailable"});
        if (rejected.status.kind === "unavailable") expect(rejected.status.reason).toContain("literal denyRead");
        await rejected.close();
        const valid = await createSandboxRuntime({cwd, storage, settings: {...settings, filesystem: {denyRead: [], denyWrite: []}}});
        try {expect(valid.status).toMatchObject({kind: "ready"});} finally {await valid.close();}
    });
}, 15000);

test.skipIf(!enabled)("default CLI settings support ordinary and scoped commands in a fresh environment", async () => {
    await withTempProject(async (cwd, storage) => {
        const settings = loadHiCodeSettings({cwd, storage, sources: []}).values.sandbox;
        const scope = join(cwd, "scope");
        await mkdir(scope);
        const sandbox = await createSandboxRuntime({cwd, storage, settings});
        try {
            expect(sandbox.status).toMatchObject({kind: "ready"});
            const runner = createShellRunner(sandbox, testChildEnvironment);
            const request = {command: "printf ready", cwd, signal: AbortSignal.timeout(5000)};
            expect((await runner.run(request)).stdout).toBe("ready");
            expect((await runner.run({...request, cwd: scope, fileWorkspace: {root: scope, writable: false}})).stdout).toBe("ready");
        } finally {await sandbox.close();}
    });
}, 15000);
