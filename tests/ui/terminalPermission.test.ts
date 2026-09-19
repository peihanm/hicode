import {expect, test} from "bun:test";
import {fileURLToPath} from "node:url";

test("real Ink permission entry, replacement and dismissal reflow code, commentary and footer without repeated clears", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/terminalPermission.tsx", import.meta.url))], {
        env: {...process.env, CI: "0", TERM: "xterm-256color"}, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try {
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({exitCode, stderr}).toEqual({exitCode: 0, stderr: ""});
        expect(stdout).toContain("permission-app-ok");
    } finally {clearTimeout(timer); child.kill();}
}, 25_000);
