import {expect, test} from "bun:test";
import {InteractiveShutdown} from "../../src/cli/interactiveShutdown.js";
import {withTempProject} from "../helpers/tempProject.js";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

test("CLI 等待卸载前后注册的清理，重复关闭共享同一 Promise", async () => {
    const shutdown = new InteractiveShutdown();
    let release!: () => void, count = 0;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const unregister = shutdown.register(async () => {count++; await gate;});
    unregister(); unregister();
    const closing = shutdown.close();
    expect(shutdown.close() === closing).toBe(true);
    expect(shutdown.signal.aborted).toBe(true);
    shutdown.register(async () => {count++; await gate;});
    let settled = false;
    void closing.then(() => {settled = true;});
    await Promise.resolve(); expect(settled).toBe(false);
    release(); await closing;
    expect(count).toBe(2);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`${signal} 等待超过一秒的真实 Root 清理并结束后台进程组`, async () => {
        await withTempProject(async cwd => {
            const fixture = fileURLToPath(new URL("../fixtures/interactiveShutdown.ts", import.meta.url));
            const child = Bun.spawn([process.execPath, fixture, cwd], {stdout: "pipe", stderr: "pipe", env: {PATH: process.env.PATH ?? ""}});
            const reader = child.stdout.getReader();
            const decoder = new TextDecoder();
            let output = "", pid: number | undefined;
            try {
                while (!output.includes("READY")) {
                    const part = await reader.read();
                    if (part.done) throw new Error(await new Response(child.stderr).text());
                    output += decoder.decode(part.value);
                }
                pid = Number((await readFile(`${cwd}/child.pid`, "utf8")).trim());
                expect(Number.isInteger(pid) && pid > 1).toBe(true);
                process.kill(pid, 0);
                child.kill(signal);
                while (true) {const part = await reader.read(); if (part.done) break; output += decoder.decode(part.value);}
                expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143);
                expect(output).toContain("CLOSED:cancelled");
                expect(() => process.kill(pid!, 0)).toThrow();
            } finally {
                reader.releaseLock(); child.kill("SIGKILL");
                if (pid && pid > 1) {try {process.kill(-pid, "SIGKILL");} catch {}}
                await child.exited;
            }
        });
    }, 8000);
}
