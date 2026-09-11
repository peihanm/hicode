import {expect, test} from "bun:test";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createPillarStorageLayout, getSessionStorageDirectory} from "../../src/persistence/index.js";

test("ordinary Agent progress is live-only while start, finish and notification remain durable", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const home = join(cwd, "task-home");
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, (options, request) => ({
            agentId: options.agentId,
            async run() {
                for (let current = 1; current <= 5; current++) {
                    await options.onChildEvent?.({type: "iteration", current, max: 5});
                    await options.onChildEvent?.({type: "token_update", tokenCount: current * 500, percentUsed: 0.1, warning: false, status: "actual"});
                }
                return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                    reply: "done", reason: "completed", iterations: 5, toolUseCount: 0, durationMs: 1};
            },
        }), home);
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        let finish!: () => void;
        const completed = new Promise<void>(resolve => {finish = resolve;});
        let progress = 0;
        const unsubscribe = session.subscribe(event => {
            if (event.type === "task_progress") progress++;
            if (event.type === "task_finished") finish();
        });
        try {
            await session.startAgent({parentContext: ctx, request: {kind: "registered", agentType: "Explore",
                description: "progress", prompt: "inspect", parentToolCallId: "start-progress"}});
            await completed;
            expect(progress).toBe(10);
            const text = await readFile(join(getSessionStorageDirectory(createPillarStorageLayout({pillarHome: home}), cwd, ctx.sessionId), "tasks", "events.jsonl"), "utf8");
            expect(text).toContain('"type":"task_started"');
            expect(text).toContain('"type":"task_finished"');
            expect(text).not.toContain('"type":"task_progress"');
            expect(await session.pendingNotifications()).toHaveLength(1);
        } finally {unsubscribe(); await runtime.close();}
    });
});
