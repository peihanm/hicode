import {afterEach, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {InteractiveEvents, type InteractiveEvent} from "../../src/ui/interactiveEvents.js";
import {AppForTest} from "../helpers/AppForTest.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {existsSync} from "node:fs";
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";

afterEach(cleanup);
async function until(check: () => boolean) {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10);
    expect(check()).toBe(true);
}

test.each(["completed", "error"] as const)("interactive %s emits exactly one persisted terminal observation", async mode => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd);
        const events: InteractiveEvent[] = [];
        const view = render(<InteractiveEvents.Provider value={{singleTask: true, emit(event) {events.push(event);}}}>
            <AppForTest resources={resources} runAgentImpl={async () => {
                if (mode === "error") throw new Error("Provider rejected fixture request");
                return {reason: "completed", reply: "done", iterations: 1};
            }}/>
        </InteractiveEvents.Provider>);
        try {
            await until(() => events.some(event => event.type === "ready"));
            view.stdin.write("probe"); await Bun.sleep(20); view.stdin.write("\r");
            await until(() => events.some(event => event.type === "settled"));
            const settled = events.filter(event => event.type === "settled");
            expect(settled).toHaveLength(1);
            expect(settled[0]).toMatchObject({status: mode === "error" ? "failed" : "completed", reason: mode,
                persistenceStatus: "saved", sealed: true, runningAgents: 0});
            expect(events.findIndex(event => event.type === "settled")).toBeGreaterThan(
                events.findIndex(event => event.type === "agent_event" && event.event.type === "turn_end"));
        } finally {view.unmount(); await resources.close();}
    });
});

test("sealed single-task UI keeps its managed service alive until Runtime cleanup and rejects another turn", async () => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd);
        const events: InteractiveEvent[] = [];
        const ready = join(cwd, "service-ready.json");
        const script = join(cwd, "service.mjs");
        await writeFile(script, `import http from 'node:http'; import fs from 'node:fs';
const server = http.createServer((_request, response) => response.end('SERVICE_OK'));
server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({port: server.address().port})));
`);
        let turns = 0;
        const view = render(<InteractiveEvents.Provider value={{singleTask: true, emit(event) {events.push(event);}}}>
            <AppForTest resources={resources} runAgentImpl={async (_prompt, _history, _event, context) => {
                turns++;
                if (!context.tasks) throw new Error("Missing task capability");
                await context.tasks.startShell({command: `node ${JSON.stringify(script)}`, cwd, toolCallId: "service"});
                return {reason: "completed", reply: "Service ready.", iterations: 1};
            }}/>
        </InteractiveEvents.Provider>);
        try {
            await until(() => events.some(event => event.type === "ready"));
            view.stdin.write("start service"); await Bun.sleep(20); view.stdin.write("\r");
            await until(() => events.some(event => event.type === "settled") && existsSync(ready));
            expect(events.find(event => event.type === "settled")).toMatchObject({sealed: true, runningAgents: 0});
            const value: unknown = JSON.parse(await readFile(ready, "utf8"));
            if (!value || typeof value !== "object" || !("port" in value) || typeof value.port !== "number")
                throw new Error("Invalid service readiness");
            const url = `http://127.0.0.1:${value.port}`;
            expect(await (await fetch(url)).text()).toBe("SERVICE_OK");
            view.stdin.write("another task"); await Bun.sleep(20); view.stdin.write("\r"); await Bun.sleep(30);
            expect(turns).toBe(1);
            expect(await (await fetch(url)).text()).toBe("SERVICE_OK");
            await resources.close();
            await expect(fetch(url)).rejects.toThrow();
        } finally {view.unmount(); await resources.close();}
    });
});
