import {expect, test} from "bun:test";
import {createServer} from "node:net";
import {mkdir, readFile, writeFile, symlink} from "node:fs/promises";
import {join} from "node:path";
import {quote} from "@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js";
import {createSandboxRuntime} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {runShellArgv} from "../../src/tools/bash/process.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {withTempProject} from "../helpers/tempProject.js";

const enabled = process.platform === "darwin" && process.env.HICODE_RUN_SANDBOX_INTEGRATION === "1";

test.skipIf(!enabled)("macOS blocks host Unix sockets, preserves open TCP/files, and grants only exact configured sockets", async () => {
    await withTempProject(async (root, storage) => {
        const cwd = join(root, "work ' 中文"); await mkdir(cwd);
        const socketPath = join(root, "a.sock"), otherSocket = join(root, "b.sock");
        const servers = [socketPath, otherSocket].map(() => createServer(socket => socket.end("SOCKET_OK")));
        const http = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("TCP_OK")});
        try {
            await Promise.all(servers.map((server, index) => new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(index ? otherSocket : socketPath, resolve);
            })));
            const script = join(cwd, "client.cjs");
            await writeFile(script, `const net = require('node:net');
const {spawnSync} = require('node:child_process');
if (process.argv[2] === 'child') {
 const result = spawnSync(process.execPath, [__filename, 'connect', process.argv[3]], {encoding:'utf8', timeout:4000});
 process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 2);
}
const socket = net.connect(process.argv[3]);
socket.setTimeout(2000, () => {socket.destroy(); process.exitCode = 2;});
socket.on('data', data => process.stdout.write(data));
socket.on('error', error => {console.error(error.code); process.exitCode = 1;});
`);
            const env = {PATH: process.env.PATH, HOME: root};
            // A denied connection proves isolation only if the host endpoint really works.
            const control = await runShellArgv({argv: ["node", script, "connect", socketPath], cwd, env, signal: AbortSignal.timeout(5000)});
            expect(control.stdout).toContain("SOCKET_OK");
            await writeFile(join(root, "outside"), "protected");
            await writeFile(join(cwd, ".env"), "protected");
            const alias = join(root, "alias.sock"); await symlink(socketPath, alias);
            for (const invalid of [cwd, join(root, "outside"), join(root, "missing.sock"), alias]) {
                const sandbox = await createSandboxRuntime({cwd, storage, settings: {
                    filesystem: {denyRead: [], denyWrite: []},
                    network: {mode: "open", allowedDomains: [], allowLocalBinding: false, allowUnixSockets: [invalid]},
                }});
                try {expect(sandbox.status.kind).toBe("unavailable");}
                finally {await sandbox.close();}
            }
            for (const mode of ["open", "restricted"] as const) for (const grants of [[], [socketPath]]) {
                const sandbox = await createSandboxRuntime({cwd, storage, settings: {
                    filesystem: {denyRead: [], denyWrite: []},
                    network: {mode, allowedDomains: [], allowLocalBinding: false, allowUnixSockets: grants},
                }});
                try {
                    expect(sandbox.status.kind).toBe("ready");
                    const runner = createShellRunner(sandbox, createChildProcessEnvironment(env, []));
                    const run = (args: string[]) => runner.run({command: quote(args), cwd, signal: AbortSignal.timeout(8000)});
                    for (const via of ["connect", "child"]) {
                        const result = await run(["node", script, via, socketPath]);
                        expect(result.termination).toMatchObject({kind: "exit", code: grants.length ? 0 : 1});
                        if (grants.length) expect(result.stdout).toContain("SOCKET_OK");
                        else {expect(result.stdout).not.toContain("SOCKET_OK"); expect(result.stderr).toMatch(/EPERM|EACCES/);}
                    }
                    const other = await run(["node", script, "connect", otherSocket]);
                    expect(other.termination).toMatchObject({kind: "exit", code: 1});
                    expect(other.stderr).toMatch(/EPERM|EACCES/);
                    const bind = await run(["node", "-e", `require('node:net').createServer().on('error',e=>{console.error(e.code);process.exitCode=1;}).listen('new.sock')`]);
                    expect(bind.termination).toMatchObject({kind: "exit", code: 1});
                    expect(bind.stderr).toMatch(/EPERM|EACCES/);
                    if (mode === "open") {
                        const tcp = await run(["node", "-e", `fetch('http://127.0.0.1:${http.port}', {signal:AbortSignal.timeout(3000)}).then(r=>r.text()).then(console.log)`]);
                        expect({stdout: tcp.stdout, stderr: tcp.stderr, termination: tcp.termination}).toMatchObject({stdout: expect.stringContaining("TCP_OK"), termination: {kind: "exit", code: 0}});
                    }
                    const writes = await run(["node", "-e", `const fs=require('node:fs'); fs.writeFileSync('ok.txt','ok'); for(const p of ['.env','../outside']) {try {fs.writeFileSync(p,'BAD');process.exitCode=1;}catch{console.log('DENIED');}}`]);
                    expect(writes.termination).toMatchObject({kind: "exit", code: 0});
                    expect(await readFile(join(cwd, "ok.txt"), "utf8")).toBe("ok");
                    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("protected");
                    expect(await readFile(join(root, "outside"), "utf8")).toBe("protected");
                } finally {await sandbox.close();}
            }
        } finally {
            http.stop(true);
            await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
        }
    });
}, 45000);
