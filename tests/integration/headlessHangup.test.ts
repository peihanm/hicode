import {expect, test} from "bun:test";
import {resolve} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";

test.skipIf(process.platform === "win32")("real Headless SIGHUP cancels the local stream and exits", async () => {
    let requested = false;
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: () => {
        requested = true;
        return new Response(new ReadableStream<Uint8Array>({start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"fixture"}}]}\n\n'));
        }}), {headers: {"content-type": "text/event-stream"}});
    }});
    try {
        await withTempProject(async (cwd, storage) => {
            const child = Bun.spawn([process.execPath, "--no-env-file", resolve(import.meta.dir, "../fixtures/headlessHangup.ts"),
                cwd, storage.hicodeHome, `http://127.0.0.1:${server.port}/v1`], {
                env: {PATH: process.env.PATH, HOME: cwd, HICODE_FIXTURE_API_KEY: "fixture-not-a-real-key", NO_PROXY: "127.0.0.1",
                    ...(process.env.HICODE_LINUX_RUNTIME_DIR ? {HICODE_LINUX_RUNTIME_DIR: process.env.HICODE_LINUX_RUNTIME_DIR} : {})},
                stdout: "pipe", stderr: "pipe",
            });
            const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
            const watchdog = setTimeout(() => child.kill("SIGKILL"), 8000);
            try {
                const deadline = Date.now() + 5000;
                while (!requested && Date.now() < deadline && child.exitCode === null) await Bun.sleep(10);
                expect(requested).toBe(true);
                child.kill("SIGHUP");
                expect(await child.exited).toBe(130);
                const output = JSON.parse(await stdout);
                expect(output.abortReason).toBe("shutdown");
                expect(await stderr).not.toContain("Unhandled");
            } finally {clearTimeout(watchdog); child.kill(); await child.exited;}
        });
    } finally {await server.stop(true);}
}, 10000);
