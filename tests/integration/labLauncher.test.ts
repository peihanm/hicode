import {expect, test} from "bun:test";
import {chmod, mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";

const script = await readFile(new URL("../../.devcontainer/linux.sh", import.meta.url), "utf8");

for (const terminal of [
    {TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.0", COLORFGBG: "0;15"},
    {TERM: "xterm", FORCE_COLOR: "0", NO_COLOR: "1"},
    {TERM: "dumb"},
]) test(`lab shell preserves terminal capabilities without forcing truecolor: ${terminal.TERM}`, async () => {
    await withTempProject(async cwd => {
        const bin = join(cwd, "bin");
        await mkdir(bin);
        const launcher = join(cwd, "linux.sh");
        const output = join(cwd, "args.txt");
        await writeFile(launcher, script);
        const docker = join(bin, "docker");
        await writeFile(docker, `#!/bin/sh
case "$*" in
  *" info") exit 0 ;;
  *" ps --status running -q dev") printf 'running-container\\n' ;;
  *" exec "*) printf '%s\\n' "$@" > "$ARGUMENT_LOG" ;;
  *) exit 97 ;;
esac
`);
        await chmod(docker, 0o755);
        const child = Bun.spawn(["/bin/bash", launcher], {cwd,
            env: {PATH: `${bin}:/usr/bin:/bin`, HICODE_DOCKER_CONTEXT: "fixture", ARGUMENT_LOG: output,
                MODEL_API_KEY: "fixture-not-to-forward", ...terminal}, stdout: "pipe", stderr: "pipe"});
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        const args = (await readFile(output, "utf8")).trim().split("\n");
        const forwarded = args.filter((_value, index) => args[index - 1] === "--env");
        expect(forwarded.sort()).toEqual(Object.entries(terminal).map(([key, value]) => `${key}=${value}`).sort());
        expect(args.slice(-5)).toEqual(["-w", "/workspaces/lab", "dev", "bash", "-l"]);
        expect(args.join(" ")).not.toContain("fixture-not-to-forward");
    });
});

test.each(["running", "stopped", "fresh"])("start uses shared Compose configuration and preserves existing containers: %s", async state => {
    await withTempProject(async cwd => {
        const bin = join(cwd, "bin"), config = join(cwd, "config with spaces"), caller = join(cwd, "caller");
        await Promise.all([mkdir(bin), mkdir(config), mkdir(caller)]);
        const launcher = join(config, "linux.sh"), output = join(cwd, "calls.jsonl");
        await writeFile(launcher, script);
        await writeFile(join(config, ".env"), `HICODE_CONTAINER_PROXY=$(touch '${join(cwd, "unexpected")}')\n`);
        const docker = join(bin, "docker");
        await writeFile(docker, `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.ARGUMENT_LOG, JSON.stringify({args,uid:process.env.HICODE_DEV_UID})+'\\n');
if(args.includes('info')) process.exit(0);
if(args.includes('ps')) {if(process.env.FIXTURE_STATE==='running'||(process.env.FIXTURE_STATE==='stopped'&&args.includes('--all'))) console.log('container');process.exit(0);}
if(args.includes('inspect')) process.exit(1);
if(['build','up','exec','start'].some(action=>args.includes(action))) process.exit(0);
process.exit(97);
`);
        await chmod(docker, 0o755);
        const child = Bun.spawn(["/bin/bash", launcher, "start"], {cwd: caller,
            env: {PATH: `${bin}:/usr/bin:/bin`, HICODE_DOCKER_CONTEXT: "fixture", ARGUMENT_LOG: output, FIXTURE_STATE: state},
            stdout: "pipe", stderr: "pipe"});
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(stderr).toBe(""); expect(code).toBe(0);
        const calls: Array<{args: string[]; uid?: string}> = (await readFile(output, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        for (const call of calls.filter(call => call.args.includes("compose"))) {
            expect(call.args[call.args.indexOf("--project-directory") + 1]).toBe(config);
            expect(call.args[call.args.indexOf("-f") + 1]).toBe(join(config, "compose.yaml"));
            expect(call.uid).toMatch(/^\d+$/);
        }
        if (state === "running") {
            expect(calls).toHaveLength(2);
        } else if (state === "stopped") {
            expect(calls).toHaveLength(4);
            expect(calls.at(-1)?.args.slice(-2)).toEqual(["start", "dev"]);
        } else {
            expect(calls.find(call => call.args.includes("build"))?.args.slice(-2)).toEqual(["build", "dev"]);
            expect(calls.find(call => call.args.includes("up"))?.args.slice(-4)).toEqual(["up", "-d", "--no-deps", "dev"]);
            expect(calls.at(-1)?.args.slice(-7)).toEqual(["-T", "-w", "/workspaces/hicode", "dev", "bun", "install", "--frozen-lockfile"]);
        }
        expect(await Bun.file(join(cwd, "unexpected")).exists()).toBe(false);
    });
});
