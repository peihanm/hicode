import {describe, expect, test} from "bun:test";
import {createServer} from "node:http";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createSandboxRuntime} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const ENABLED = process.env.PILLAR_RUN_SANDBOX_INTEGRATION === "1";

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

describe("OS Sandbox integration", () => {
    test("真实 OS 边界限制文件、网络和子进程", async () => {
        if (!ENABLED) return;
        await withTempProject(async (cwd) => {
            const outside = await mkdtemp(join(tmpdir(), "pillar-sandbox-outside-"));
            const secretPath = join(outside, "secret.txt");
            const blockedPath = join(outside, "blocked.txt");
            const elevatedPath = join(outside, "elevated.txt");
            const allowedPath = join(cwd, "allowed.txt");
            const pillarPath = join(cwd, ".pillar", "blocked.txt");
            await writeFile(secretPath, "secret", "utf8");
            await mkdir(join(cwd, ".pillar"), {recursive: true});

            let serverHits = 0;
            const server = createServer((_request, response) => {
                serverHits += 1;
                response.end("reachable");
            });
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (!address || typeof address === "string") {
                throw new Error("无法取得 Sandbox 测试端口");
            }

            const runtime = await createSandboxRuntime({
                cwd,
                settings: {
                    enabled: true,
                    filesystem: {
                        allowWrite: ["."],
                        denyRead: [secretPath],
                        denyWrite: [],
                    },
                    network: {
                        allowedDomains: [],
                        allowLocalBinding: false,
                    },
                },
            });
            try {
                expect(runtime.status).toMatchObject({kind: "ready"});
                const runner = createShellRunner(runtime, testChildEnvironment);
                const signal = new AbortController().signal;

                const allowed = await runner.run({
                    command: `/usr/bin/printf allowed > ${JSON.stringify(allowedPath)}`,
                    cwd,
                    signal,
                });
                expect(allowed.termination).toMatchObject({kind: "exit", code: 0});
                expect(await readFile(allowedPath, "utf8")).toBe("allowed");

                const blocked = await runner.run({
                    command: `/bin/sh -c ${JSON.stringify(`/usr/bin/printf blocked > ${blockedPath}`)}`,
                    cwd,
                    signal,
                });
                expect(blocked.termination).toMatchObject({kind: "exit", code: 1});
                expect(await exists(blockedPath)).toBe(false);

                const deniedRead = await runner.run({
                    command: `/bin/cat ${JSON.stringify(secretPath)}`,
                    cwd,
                    signal,
                });
                expect(deniedRead.termination).toMatchObject({kind: "exit", code: 1});
                expect(deniedRead.stdout).not.toContain("secret");

                const protectedPillar = await runner.run({
                    command: `/usr/bin/printf blocked > ${JSON.stringify(pillarPath)}`,
                    cwd,
                    signal,
                });
                expect(protectedPillar.termination).toMatchObject({kind: "exit", code: 1});
                expect(await exists(pillarPath)).toBe(false);

                const deniedNetwork = await runner.run({
                    command: `/usr/bin/curl --silent --show-error --max-time 2 http://127.0.0.1:${address.port}`,
                    cwd,
                    signal,
                });
                expect(deniedNetwork.termination).toMatchObject({kind: "exit"});
                expect(
                    deniedNetwork.termination.kind === "exit"
                        ? deniedNetwork.termination.code
                        : 0
                ).not.toBe(0);
                expect(serverHits).toBe(0);

                const elevated = await runner.run({
                    command: `/usr/bin/printf elevated > ${JSON.stringify(elevatedPath)}`,
                    cwd,
                    signal,
                    sandboxPermissions: "require_escalated",
                });
                expect(elevated.termination).toMatchObject({kind: "exit", code: 0});
                expect(await readFile(elevatedPath, "utf8")).toBe("elevated");
            } finally {
                await runtime.close();
                await new Promise<void>((resolve, reject) =>
                    server.close((error) => error ? reject(error) : resolve())
                );
                await rm(outside, {recursive: true, force: true});
            }
        });
    });
});
