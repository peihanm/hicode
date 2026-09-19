import {expect, test} from "bun:test";
import {InteractiveShutdown, bindInteractiveSignals} from "../../src/cli/interactiveShutdown.js";
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

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${signal} 等待超过一秒的真实 Root 清理并结束后台进程组`, async () => {
        await withTempProject(async cwd => {
            const fixture = fileURLToPath(new URL("../fixtures/interactiveShutdown.ts", import.meta.url));
            const child = Bun.spawn([process.execPath, fixture, cwd], {stdout: "pipe", stderr: "pipe", env: {PATH: process.env.PATH ?? ""}});
            const reader = child.stdout.getReader();
            const decoder = new TextDecoder();
            let output = "", pid: number | undefined, grandchild: number | undefined;
            try {
                while (!output.includes("READY")) {
                    const part = await reader.read();
                    if (part.done) throw new Error(await new Response(child.stderr).text());
                    output += decoder.decode(part.value);
                }
                pid = Number((await readFile(`${cwd}/child.pid`, "utf8")).trim());
                expect(Number.isInteger(pid) && pid > 1).toBe(true);
                grandchild = Number((await readFile(`${cwd}/grandchild.pid`, "utf8")).trim());
                process.kill(pid, 0);
                process.kill(grandchild, 0);
                child.kill(signal);
                child.kill(signal);
                while (true) {const part = await reader.read(); if (part.done) break; output += decoder.decode(part.value);}
                expect(await child.exited).toBe(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
                expect(output).toContain("CLOSED:cancelled");
                expect(() => process.kill(pid!, 0)).toThrow();
                expect(() => process.kill(grandchild!, 0)).toThrow();
            } finally {
                reader.releaseLock(); child.kill("SIGKILL");
                if (pid && pid > 1) {try {process.kill(-pid, "SIGKILL");} catch {}}
                await child.exited;
            }
        });
    }, 8000);
}

test("signal bindings dispose without accumulating handlers", () => {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const before = signals.map(signal => process.listenerCount(signal));
    const shutdown = new InteractiveShutdown();
    const dispose = bindInteractiveSignals(shutdown, () => {throw new Error("Unexpected exit");});
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(before.map(n => n + 1));
    dispose(); dispose();
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(before);
});

test.each(["terminal", "terminal-idle"])("closing a real PTY without SIGHUP cleans up Root and command group (%s)", async mode => {
    await withTempProject(async cwd => {
        let ready!: () => void;
        const started = new Promise<void>(resolve => {ready = resolve;});
        const decoder = new TextDecoder();
        let output = "";
        const terminal = new Bun.Terminal({data(_terminal, data) {
            output += decoder.decode(data);
            if (output.includes("READY")) ready();
        }});
        const fixture = fileURLToPath(new URL("../fixtures/interactiveShutdown.ts", import.meta.url));
        const child = Bun.spawn([process.execPath, fixture, cwd, mode], {terminal, env: {PATH: process.env.PATH ?? ""}});
        const deadline = setTimeout(() => child.kill("SIGKILL"), 7_000);
        let pid: number | undefined;
        try {
            await Promise.race([started, child.exited.then(code => {throw new Error(`Fixture exited before READY (${code}): ${output}`);})]);
            pid = Number((await readFile(`${cwd}/child.pid`, "utf8")).trim());
            const grandchild = Number((await readFile(`${cwd}/grandchild.pid`, "utf8")).trim());
            terminal.close();
            expect(await child.exited).toBe(129);
            expect(JSON.parse(await readFile(`${cwd}/closed.json`, "utf8"))).toEqual({status: "cancelled", code: 129});
            expect(() => process.kill(pid!, 0)).toThrow();
            expect(() => process.kill(grandchild, 0)).toThrow();
        } finally {
            clearTimeout(deadline);
            terminal.close();
            child.kill("SIGKILL");
            if (pid && pid > 1) {try {process.kill(-pid, "SIGKILL");} catch {}}
            await child.exited;
        }
    });
}, 10_000);

test("redirected stdin EOF does not close an interactive CLI's resources", async () => {
    await withTempProject(async cwd => {
        const fixture = fileURLToPath(new URL("../fixtures/interactiveShutdown.ts", import.meta.url));
        const child = Bun.spawn([process.execPath, fixture, cwd], {stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {PATH: process.env.PATH ?? ""}});
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        const deadline = setTimeout(() => child.kill("SIGKILL"), 6_000);
        let output = "", pid: number | undefined;
        try {
            while (!output.includes("READY")) {
                const part = await reader.read();
                if (part.done) throw new Error(await new Response(child.stderr).text());
                output += decoder.decode(part.value);
            }
            pid = Number((await readFile(`${cwd}/child.pid`, "utf8")).trim());
            child.stdin.end();
            await Bun.sleep(1_100);
            expect(child.exitCode).toBeNull();
            process.kill(pid, 0);
            child.kill("SIGTERM");
            expect(await child.exited).toBe(143);
            expect(() => process.kill(pid!, 0)).toThrow();
        } finally {
            clearTimeout(deadline);
            reader.releaseLock(); child.kill("SIGKILL");
            if (pid && pid > 1) {try {process.kill(-pid, "SIGKILL");} catch {}}
            await child.exited;
        }
    });
}, 8_000);
