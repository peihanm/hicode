import {expect, test} from "bun:test";
import {writeFile, readFile} from "node:fs/promises";
import {join} from "node:path";
import {runShellCommand} from "../../src/tools/bash/process.js";
import {withTempProject} from "../helpers/tempProject.js";

function alive(pid: number): boolean {
    const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    return result.exitCode === 0 && !result.stdout.toString().trim().startsWith("Z");
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

for (const tty of [false, true]) for (const inherited of [false, true]) {
    test.skipIf(process.platform === "win32")(`normal Shell exit reaps descendants (PTY=${tty}, inherited pipes=${inherited}) and preserves output/status`, async () => {
        await withTempProject(async cwd => {
            const pidFile = join(cwd, "pid"), script = join(cwd, "launch.mjs");
            await writeFile(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
                const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${JSON.stringify(inherited ? "inherit" : "ignore")}});
                child.unref();writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
                process.stdout.write('x'.repeat(65536)+'FINAL_OUTPUT');process.exitCode=7;`);
            let pid: number | undefined;
            try {
                const result = await runShellCommand({command: `${quote(process.execPath)} ${quote(script)}`, cwd,
                    tty, signal: AbortSignal.timeout(5000), timeoutMs: 4000});
                pid = Number(await readFile(pidFile, "utf8"));
                expect(result.termination).toMatchObject({kind: "exit", code: 7});
                expect(result.stdout).toBe("x".repeat(65536) + "FINAL_OUTPUT");
                const deadline = Date.now() + 1000;
                while (alive(pid) && Date.now() < deadline) await Bun.sleep(10);
                expect(alive(pid)).toBe(false);
            } finally {
                pid ??= Number(await readFile(pidFile, "utf8").catch(() => "0"));
                if (pid) {try {process.kill(pid, "SIGKILL");} catch {}}
            }
        });
    }, 7000);
}

test.skipIf(process.platform === "win32")("finite foreground test can signal and await its own child", async () => {
    await withTempProject(async cwd => {
        const script = join(cwd, "signal-test.mjs");
        const childCode = `process.on('SIGINT',()=>{setTimeout(()=>{console.log('CLEANUP_COMPLETE');process.exit(0)},30)});console.log('READY');setInterval(()=>{},1000);`;
        await writeFile(script, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','pipe']});
const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code)=>resolve(code))});
let output=''; let sent=false;
child.stdout.on('data',data=>{output+=data; if(!sent&&output.includes('READY')){sent=true;child.kill('SIGINT')}});
const timeout=setTimeout(()=>child.kill('SIGKILL'),1500);
try {const code=await closed;if(code!==0||!output.includes('CLEANUP_COMPLETE'))throw Error('Child cleanup did not finish');console.log('VERIFIED_CLEANUP_COMPLETE')}
finally {clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed}}
`);
        const result = await runShellCommand({command: `${quote(process.execPath)} ${quote(script)}`, cwd,
            signal: AbortSignal.timeout(4000), timeoutMs: 3000});
        expect(result.termination).toMatchObject({kind: "exit", code: 0});
        expect(result.stdout).toContain("VERIFIED_CLEANUP_COMPLETE");
    });
}, 5000);
