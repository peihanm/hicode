import {expect, test} from "bun:test";
import {fileURLToPath} from "node:url";

test("real Ink: diff 后的实时区域溢出再收缩，不残留空行且后续不重复清屏", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/terminalOverflow.tsx", import.meta.url))], {
        env: {...process.env, CI: "0", TERM: "xterm-256color"},
        stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 5_000);
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect({exitCode, stderr}).toEqual({exitCode: 0, stderr: ""});
        expect(stdout).toContain("terminal-overflow-ok");
    } finally {
        clearTimeout(timer);
        child.kill();
    }
}, 8_000);
