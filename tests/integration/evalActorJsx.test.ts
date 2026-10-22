import {expect, test} from "bun:test";
import {mkdir, readFile, realpath, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";

test("evaluation CLI uses its frozen JSX config in a classic React benchmark workspace", async () => {
    await withTempProject(async directory => {
        const root = await realpath(directory), cwd = join(root, "workspace"), home = join(root, "home"), log = join(root, "events.jsonl");
        const release = resolve(import.meta.dir, "../..");
        await mkdir(cwd); await mkdir(join(home, ".hicode"), {recursive: true});
        await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({compilerOptions: {jsx: "react", jsxFactory: "BenchmarkReact.createElement"}}));
        await writeFile(join(home, ".hicode/settings.json"), JSON.stringify({
            sources: {qwen: {baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "EVAL_FIXTURE_KEY", models: [{id: "qwen3.8-flash", label: "Fixture"}]}},
            models: {primary: {source: "qwen", model: "qwen3.8-flash"}}, memory: {enabled: false},
        }));
        const generated = Bun.spawnSync(["python3", "-B", "-c",
            "import json,sys;sys.path.insert(0,sys.argv[1]);from protocol import hicode_command;print(json.dumps(hicode_command(sys.argv[2],sys.argv[3],'full-access',{'source':'qwen','model':'qwen3.8-flash'})))",
            join(release, "hicode-eval/src/worker"), release, log], {stdout: "pipe", stderr: "pipe"});
        expect(generated.exitCode).toBe(0);
        const args: unknown = JSON.parse(new TextDecoder().decode(generated.stdout));
        if (!Array.isArray(args) || !args.every((value): value is string => typeof value === "string")) throw Error("Invalid Actor command");
        let baselineScreen = "";
        const baselineTerminal = new Bun.Terminal({cols: 140, rows: 40, data(_terminal, bytes) {baselineScreen += new TextDecoder().decode(bytes);}});
        const env = {PATH: process.env.PATH ?? "", HOME: home, EVAL_FIXTURE_KEY: "offline-fixture", TERM: "xterm-256color", LANG: "C.UTF-8"};
        const baseline = Bun.spawn([process.execPath, join(release, "src/index.tsx"), "--event-log", join(root, "baseline-events.jsonl"),
            "--permission-mode", "full-access", "--source", "qwen", "--model", "qwen3.8-flash"], {cwd, terminal: baselineTerminal, env});
        const baselineTimeout = setTimeout(() => baseline.kill("SIGKILL"), 5000);
        try {
            expect(await baseline.exited).toBe(1);
            expect(baselineScreen).toContain("BenchmarkReact is not defined");
        } finally {
            clearTimeout(baselineTimeout); baseline.kill("SIGKILL"); await baseline.exited; baselineTerminal.close();
        }
        let screen = "";
        const terminal = new Bun.Terminal({cols: 140, rows: 40, data(_terminal, bytes) {screen = (screen + new TextDecoder().decode(bytes)).slice(-8000);}});
        const child = Bun.spawn([process.execPath, ...args.slice(1)], {
            cwd, terminal, env,
        });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 12000);
        try {
            const deadline = Date.now() + 8000;
            while (!(await readFile(log, "utf8").catch(() => "")).includes('"type":"ready"')) {
                if (child.exitCode !== null || Date.now() > deadline) throw Error(`Actor CLI failed to become ready: ${screen}`);
                await Bun.sleep(20);
            }
            expect(screen).not.toContain("React is not defined");
            expect(screen).not.toContain("BenchmarkReact is not defined");
            expect(await readFile(join(cwd, "tsconfig.json"), "utf8")).toContain("BenchmarkReact.createElement");
            child.kill("SIGTERM");
            expect(await child.exited).toBe(143);
            expect(await readFile(log, "utf8")).not.toContain('"type":"iteration"');
        } finally {
            clearTimeout(timeout); child.kill("SIGKILL"); await child.exited; terminal.close();
        }
    });
}, 15000);
