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
import {cliTemporaryDirectories} from "../../src/cli/temporaryDirectories.js";
import {realpath} from "node:fs/promises";
import {createSandboxRuntime} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {createTestContext} from "../helpers/testContext.js";
import {NetworkAccessSession} from "../../src/permissions/networkAccess.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";

const ENABLED = process.env.HICODE_RUN_SANDBOX_INTEGRATION === "1";

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

describe("OS Sandbox integration", () => {
    test("CLI 标准临时目录可写且显式禁止仍生效", async () => {
        if (!ENABLED) return;
        await withTempProject(async (cwd, storage) => {
            const scratch = await mkdtemp(join("/tmp", "hicode-temp-check-"));
            const allowed = join(scratch, "backup.txt");
            const denied = join(await realpath(scratch), "denied.txt");
            const runtime = await createSandboxRuntime({cwd, storage,
                writableRoots: await cliTemporaryDirectories(),
                settings: {filesystem: {denyRead: [], denyWrite: [denied]},
                    network: {mode: "restricted", allowedDomains: [], allowLocalBinding: false}},
            });
            try {
                expect(runtime.status.kind).toBe("ready");
                const runner = createShellRunner(runtime, testChildEnvironment);
                const result = await runner.run({cwd, signal: new AbortController().signal,
                    command: `printf backup > '${allowed}' && printf '%s' "$TMPDIR"`});
                expect(result.termination).toMatchObject({kind: "exit", code: 0});
                expect(await readFile(allowed, "utf8")).toBe("backup");
                expect(result.stdout).toBe(await realpath(tmpdir()));
                const rejected = await runner.run({cwd, signal: new AbortController().signal,
                    command: `printf blocked > '${denied}'`});
                expect(rejected.termination).toMatchObject({kind: "exit", code: 1});
                expect(await exists(denied)).toBe(false);
            } finally {
                await runtime.close();
                await rm(scratch, {recursive: true, force: true});
            }
        });
    });
    test("实际代理批准域名后保留文件隔离，重复请求复用 Session 授权", async () => {
        if (!ENABLED) return;
        await withTempProject(async (cwd, storage) => {
            let hits = 0;
            const server = createServer((_request, response) => { hits++; response.end("network-ok"); });
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("missing test port");
            await mkdir(join(cwd, ".hicode"), {recursive: true});
            const blockedPath = join(cwd, ".hicode", "network-must-not-enable-write.txt");
            const runtime = await createSandboxRuntime({cwd, storage, settings: {
                filesystem: {denyRead: [], denyWrite: []},
                network: {mode: "restricted", allowedDomains: [], allowLocalBinding: false},
            }});
            const runner = createShellRunner(runtime, testChildEnvironment);
            const tasks = createTaskRuntimeForTest(cwd, runner, () => ({
                agentId: "unused",
                async run() { throw new Error("network test does not launch agents"); },
            }));
            try {
                expect(runtime.status.kind).toBe("ready");
                let asks = 0;
                const ctx = createTestContext(cwd, {
                    shellRunner: runner, permissionMode: "ask",
                    canUseTool: async (_tool, _message, _input, options) => {
                        asks++;
                        expect(options?.presentation).toEqual({
                            kind: "network_access", host: "127.0.0.1", port: address.port,
                        });
                        return {behavior: "allow", networkScope: "session"};
                    },
                });
                ctx.networkAccess = new NetworkAccessSession();
                // Force even loopback through the authenticated proxy; no internet required.
                const command = `/usr/bin/curl --noproxy '' --silent --show-error --fail --max-time 5 http://127.0.0.1:${address.port}`;
                for (let index = 0; index < 2; index++) {
                    const result = await executeToolResult("bash", JSON.stringify({command}), ctx, `network-${index}`);
                    expect(result.outcome).toBe("ok");
                    expect(result.modelContent).toBe("network-ok");
                }
                expect(asks).toBe(1);
                expect(hits).toBe(2);
                const blocked = await executeToolResult("bash", JSON.stringify({
                    command: `${command} && /usr/bin/printf forbidden > ${JSON.stringify(blockedPath)}`,
                }), ctx, "network-still-sandboxed");
                expect(blocked.outcome).toBe("failed");
                expect(blocked.modelContent).toContain("network-ok");
                expect(await exists(blockedPath)).toBe(false);
                expect(asks).toBe(1);

                ctx.tasks = tasks.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
                const background = await executeToolResult("bash", JSON.stringify({
                    command, run_in_background: true,
                }), ctx, "network-background");
                expect(background.outcome).toBe("ok");
                expect(background.modelContent).toContain("network-ok");
                expect(asks).toBe(1);
                expect(hits).toBe(4);

                // An unrelated execution cannot consume another Session's allowance.
                const denied = await runner.run({command, cwd, signal: new AbortController().signal});
                expect(denied.termination).toMatchObject({kind: "exit", code: 22});
                expect(denied.stderr).toContain("local network permission restriction");
                expect(hits).toBe(4);
            } finally {
                await tasks.close();
                await runtime.close();
                await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            }
        });
    });

    test("真实 OS 边界限制文件、网络和子进程", async () => {
        if (!ENABLED) return;
        await withTempProject(async (cwd, storage) => {
            const outside = await mkdtemp(join(tmpdir(), "hicode-sandbox-outside-"));
            const secretPath = join(outside, "secret.txt");
            const blockedPath = join(outside, "blocked.txt");
            const elevatedPath = join(outside, "elevated.txt");
            const allowedPath = join(cwd, "allowed.txt");
            const defaultAllowedPath = join(cwd, "default-allowed.txt");
            const hicodePath = join(cwd, ".hicode", "blocked.txt");
            await writeFile(secretPath, "secret", "utf8");
            await mkdir(join(cwd, ".hicode"), {recursive: true});

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
                storage,
                settings: {
                                        filesystem: {
                        denyRead: [secretPath],
                        denyWrite: [],
                    },
                    network: {
                        mode: "restricted", allowedDomains: [],
                        allowLocalBinding: true,
                    },
                },
            });
            try {
                expect(runtime.status).toMatchObject({kind: "ready"});
                const runner = createShellRunner(runtime, testChildEnvironment);
                const signal = new AbortController().signal;

                const defaultResult = await executeToolResult(
                    "bash",
                    JSON.stringify({
                        command: `/usr/bin/printf default-allowed > ${JSON.stringify(defaultAllowedPath)}`,
                    }),
                    createTestContext(cwd, {
                        permissionMode: "ask",
        collaborationMode: "build",
                        shellRunner: runner,
                        canUseTool: async () => {
                            throw new Error("ready Sandbox 内的普通 Bash 不应请求权限");
                        },
                    }),
                    "real-default-sandbox-bash"
                );
                expect(defaultResult.outcome).toBe("ok");
                expect(await readFile(defaultAllowedPath, "utf8")).toBe("default-allowed");

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

                const protectedHiCode = await runner.run({
                    command: `/usr/bin/printf blocked > ${JSON.stringify(hicodePath)}`,
                    cwd,
                    signal,
                });
                expect(protectedHiCode.termination).toMatchObject({kind: "exit", code: 1});
                expect(await exists(hicodePath)).toBe(false);

                const localBinding = await runner.run({
                    command: `node -e ${JSON.stringify([
                        "const http = require('node:http')",
                        "const server = http.createServer((_req, res) => res.end('ok'))",
                        "server.listen(0, '127.0.0.1', () => server.close(() => console.log('local-binding-ok')))",
                    ].join(";"))}`,
                    cwd,
                    signal,
                });
                expect(localBinding.termination)
                    .toMatchObject({kind: "exit", code: 0});
                expect(localBinding.stdout.trim()).toBe("local-binding-ok");

                const allowedLocalNetwork = await runner.run({
                    command: `/usr/bin/curl --silent --show-error --max-time 2 http://127.0.0.1:${address.port}`,
                    cwd,
                    signal,
                });
                expect(allowedLocalNetwork.termination)
                    .toMatchObject({kind: "exit", code: 0});
                expect(allowedLocalNetwork.stdout).toBe("reachable");
                expect(serverHits).toBe(1);

                const deniedRemoteNetwork = await runner.run({
                    command: "/usr/bin/curl --silent --show-error --max-time 2 https://example.com",
                    cwd,
                    signal,
                });
                expect(deniedRemoteNetwork.termination).toMatchObject({kind: "exit"});
                expect(
                    deniedRemoteNetwork.termination.kind === "exit"
                        ? deniedRemoteNetwork.termination.code
                        : 0
                ).not.toBe(0);

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
