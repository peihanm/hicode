import {expect, test} from "bun:test";
import {fileURLToPath} from "node:url";

test("real Ink streams completed draft rows once and retracts/reflows them at lifecycle boundaries", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../fixtures/terminalDraft.tsx", import.meta.url))], {
        env: {...process.env, CI: "0", TERM: "xterm-256color"}, stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 8000);
    try {
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({exitCode, stderr}).toEqual({exitCode: 0, stderr: ""});
        expect(stdout).toContain("terminal-draft-ok");
    } finally {clearTimeout(timer); child.kill();}
}, 10000);
