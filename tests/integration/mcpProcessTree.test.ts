import {expect, test} from "bun:test";
import {readFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {connectMcpServer} from "../../src/mcp/client.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import type {McpConnectedServer} from "../../src/mcp/types.js";

function alive(pid: number): boolean {
    const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    return result.exitCode === 0 && !result.stdout.toString().trim().startsWith("Z");
}

for (const mode of ["normal", "stubborn", "startup-failure", "natural-exit", "final-response"]) {
    test.skipIf(process.platform === "win32")(`MCP reaps its process group after ${mode}`, async () => {
        await withTempProject(async cwd => {
            const pidFile = join(cwd, "pids.json");
            let client: McpConnectedServer | undefined;
            let pids: {parent: number; child: number} | undefined;
            try {
                const connect = connectMcpServer({name: "fixture", source: "host", id: "fixture", config: {
                    type: "stdio", command: process.execPath,
                    args: [resolve(import.meta.dir, "../fixtures/mcp/processTreeServer.ts"), pidFile, mode],
                    disabled: false, timeoutMs: 2000, toolTimeoutMs: 2000,
                }}, cwd, testChildEnvironment);
                if (mode === "startup-failure") await expect(connect).rejects.toThrow("Fixture initialization failed");
                else client = await connect;
                pids = JSON.parse(await readFile(pidFile, "utf8"));
                if (!pids) throw new Error("Missing fixture pids");
                if (mode === "natural-exit" || mode === "final-response") {
                    const result = await client!.callTool("exit", {}, AbortSignal.timeout(2000));
                    if (mode === "final-response") expect(result).toMatchObject({content: [{type: "text", text: expect.stringContaining("FINAL_RESPONSE")}]});
                }
                else await Promise.all([client?.close(), client?.close()]);
                const deadline = Date.now() + 3000;
                while ((alive(pids.parent) || alive(pids.child)) && Date.now() < deadline) await Bun.sleep(10);
                expect(alive(pids.parent)).toBe(false);
                expect(alive(pids.child)).toBe(false);
            } finally {
                await client?.close();
                pids ??= JSON.parse(await readFile(pidFile, "utf8").catch(() => "null"));
                for (const pid of pids ? [pids.parent, pids.child] : []) {try {process.kill(pid, "SIGKILL");} catch {}}
            }
        });
    }, 10000);
}
