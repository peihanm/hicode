import {expect, test} from "bun:test";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createToolRuntime} from "../../src/tools/runtime.js";

test("bash_task 拒绝 Agent ID 时不取消、不 ACK，跨 Session 不泄露任务", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        let finish!: () => void;
        const gate = new Promise<void>(resolve => { finish = resolve; });
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, (options, request) => ({
            agentId: options.agentId,
            async run(input) {
                await Promise.race([gate, new Promise<void>(resolve => {
                    if (input.signal.aborted) resolve();
                    else input.signal.addEventListener("abort", () => resolve(), {once: true});
                })]);
                return {agentId: options.agentId, agentType: request.agentType,
                    description: request.description, reply: "done",
                    reason: input.signal.aborted ? "interrupted" : "completed",
                    iterations: 1, toolUseCount: 0, durationMs: 0};
            },
        }));
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        ctx.tasks = session;
        const tools = createToolRuntime();
        try {
            const task = await session.startAgent({parentContext: ctx, request: {
                kind: "registered", agentType: "Explore", description: "kind test",
                prompt: "wait", parentToolCallId: "start-kind",
            }});
            const wrong = await tools.executeTool("bash_task", JSON.stringify({task_id: task.id, action: "stop"}), ctx, "wrong-kind");
            expect(wrong.outcome).toBe("failed");
            expect((await session.get(task.id))?.status).toBe("running");
            const other = createTestContext(cwd, {sessionId: "other"});
            other.tasks = runtime.forSession({sessionId: other.sessionId, toolResultStore: other.toolResultStore});
            const hidden = await tools.executeTool("bash_task", JSON.stringify({task_id: task.id, action: "stop"}), other, "other-session");
            expect(hidden.modelContent).toContain("不存在");
            let completed!: () => void;
            const done = new Promise<void>(resolve => { completed = resolve; });
            const unsubscribe = session.subscribe(event => {
                if (event.type === "task_finished") completed();
            });
            finish();
            await done;
            unsubscribe();
            // Wrong-type calls must not acknowledge even an already finished task.
            expect((await tools.executeTool("bash_task", JSON.stringify({task_id: task.id, action: "stop"}), ctx, "finished-kind")).outcome).toBe("failed");
            await runtime.close();
            const restoredRuntime = createTaskRuntimeForTest(cwd, ctx.shellRunner);
            try {
                const restored = restoredRuntime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
                ctx.tasks = restored;
                await restored.initialize();
                expect((await tools.executeTool("bash_task", JSON.stringify({task_id: task.id, action: "stop"}), ctx, "archived-kind")).outcome).toBe("failed");
                expect(await restored.pendingNotifications()).toHaveLength(1);
            } finally {
                await restoredRuntime.close();
            }
        } finally {
            finish();
            await runtime.close();
        }
    });
});
