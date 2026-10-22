import {expect, test} from "bun:test";
import {mkdir, readFile, realpath, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";

for (const phase of ["model", "tool"] as const) test(`SIGTERM closes actual evaluation CLI records during ${phase}`, async () => {
    await withTempProject(async directory => {
        const root = await realpath(directory), cwd = join(root, "workspace"), home = join(root, "home"), log = join(root, "events.jsonl");
        await mkdir(cwd); await mkdir(join(home, ".hicode"), {recursive: true});
        let requests = 0;
        const server = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(request) {
            await request.json(); requests++;
            if (phase === "model") {
                return new Response(new ReadableStream({start(controller) {
                    request.signal.addEventListener("abort", () => {try {controller.close();} catch {}}, {once: true});
                }}), {headers: {"Content-Type": "text/event-stream"}});
            }
            const delta = {tool_calls: [{index: 0, id: "call_wait", type: "function", function: {
                name: "bash", arguments: JSON.stringify({command: "echo $$ > shell.pid; printf live > marker; sleep 60"}),
            }}]};
            const chunks = [{choices: [{index: 0, delta, finish_reason: null}]},
                {choices: [{index: 0, delta: {}, finish_reason: "tool_calls"}]}];
            return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {headers: {"Content-Type": "text/event-stream"}});
        }});
        await writeFile(join(home, ".hicode/settings.json"), JSON.stringify({
            sources: {qwen: {baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKeyEnv: "EVAL_FIXTURE_KEY", models: [{id: "qwen3.8-flash", label: "Fixture"}]}},
            models: {primary: {source: "qwen", model: "qwen3.8-flash"}}, memory: {enabled: false},
        }));
        let screen = "";
        const terminal = new Bun.Terminal({cols: 140, rows: 40, data(_terminal, bytes) {screen = (screen + new TextDecoder().decode(bytes)).slice(-4000);}});
        const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../src/index.tsx"), "--event-log", log, "--permission-mode", "full-access"], {
            cwd, terminal, env: {PATH: process.env.PATH ?? "", HOME: home, EVAL_FIXTURE_KEY: "offline-fixture", TERM: "xterm-256color", LANG: "C.UTF-8"},
        });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
        const waitFor = async (condition: () => Promise<boolean>) => {
            const deadline = Date.now() + 8000;
            while (!await condition()) {
                if (child.exitCode !== null || Date.now() >= deadline) throw Error(`CLI did not reach ${phase} checkpoint: ${screen}`);
                await Bun.sleep(20);
            }
        };
        const text = () => readFile(log, "utf8").catch(() => "");
        try {
            await waitFor(async () => (await text()).includes('"type":"ready"'));
            terminal.write("Run the requested command and wait.");
            await Bun.sleep(500);
            terminal.write("\r");
            if (phase === "tool") await waitFor(() => Bun.file(join(cwd, "marker")).exists());
            else await waitFor(async () => requests === 1);
            child.kill("SIGTERM");
            expect(await child.exited).toBe(143);
            const events = (await text()).trim().split("\n").map(line => JSON.parse(line));
            const agentEvents = events.filter(event => event.type === "agent_event").map(event => event.event);
            expect(agentEvents.find(event => event.type === "turn_end")?.input.persistence_status).toBe("saved");
            if (phase === "tool") {
                expect(agentEvents.filter(event => event.type === "tool_call_start")).toHaveLength(1);
                expect(agentEvents.filter(event => event.type === "tool_call_end")).toHaveLength(1);
                expect(agentEvents.find(event => event.type === "tool_call_end")?.outcome).toBe("interrupted");
            }
            expect(requests).toBe(1);
            let records = 0;
            for await (const path of new Bun.Glob("**/debug/requests/*/run.json").scan({cwd: home, absolute: true, dot: true})) {
                const record = JSON.parse(await readFile(path, "utf8"));
                expect(record.pending).toEqual([]);
                expect(record.completedAt).toBeTruthy();
                records++;
            }
            expect(records).toBe(1);
        } finally {
            clearTimeout(timeout); child.kill("SIGKILL"); await child.exited;
            const pid = Number(await readFile(join(cwd, "shell.pid"), "utf8").catch(() => "0"));
            if (Number.isSafeInteger(pid) && pid > 1) {try {process.kill(-pid, "SIGKILL");} catch {}}
            terminal.close(); server.stop(true);
        }
    });
}, 20000);
