import {expect, spyOn, test} from "bun:test";
import {createSubagentLauncher} from "../../src/subagents/launcher.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";
import {runAgentForTest} from "../helpers/agent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {waitForTaskCompletion} from "../../src/tasks/wait.js";

function latch() {
    let resolve = () => {};
    const promise = new Promise<void>(done => {resolve = done;});
    return {promise, resolve};
}

test("default Agent launch returns a stable managed ID before work completes; old mode arguments are rejected", async () => {
    await withTempProject(async cwd => {
        const gate = latch();
        const base = createTestContext(cwd);
        let launches = 0;
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, (options, request) => {
            launches++;
            return {agentId: options.agentId, async close() {}, async run() {
                await gate.promise;
                return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                    reply: "verified evidence", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 1};
            }};
        });
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks});
        ctx.subagentLauncher = createSubagentLauncher({parentContext: ctx, getHistory: () => []});
        try {
            const started = await executeToolResult("agent", JSON.stringify({description: "inspect", prompt: "inspect"}), ctx, "spawn");
            expect(started.outcome).toBe("ok");
            const id = String(started.modelContent).match(/task_id: (t_[a-f0-9]{12})/)![1]!;
            expect((await tasks.get(id))?.status).toBe("running");
            expect(ctx.taskJoin!.ids).toEqual([id]);
            for (const mode of [false, true]) {
                const invalid = await executeToolResult("agent", JSON.stringify({description: "inspect", prompt: "inspect", run_in_background: mode}), ctx, `invalid-${mode}`);
                expect(invalid.outcome).toBe("failed");
            }
            expect(launches).toBe(1);
            for (let i = 0; i < 2; i++) {
                const waited = await executeToolResult("task", JSON.stringify({action: "wait", task_id: id, wait_ms: 5}), ctx, `wait-${i}`);
                expect(waited.modelContent).toContain("Wait window elapsed");
                expect(waited.modelContent).toContain(id);
                expect((await tasks.get(id))?.status).toBe("running");
                expect(ctx.taskJoin!.ids).toEqual([id]);
            }
            gate.resolve();
            const done = await executeToolResult("task", JSON.stringify({action: "wait", task_id: id}), ctx, "result");
            expect(done.modelContent).toContain("verified evidence");
            expect(ctx.taskJoin!.ids).toEqual([]);
            expect(launches).toBe(1);
            const notification = (await tasks.pendingNotifications())[0]!;
            expect(ctx.taskJoin!.accepts({source: "task_notification", id: notification.notificationId, taskId: id, content: notification.message})).toBe(false);
        } finally {gate.resolve(); await runtime.close();}
    });
});

test.each(["missing", "forbidden"] as const)("Agent launch rejects %s task capability without synchronous execution", async mode => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        let launches = 0;
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, () => {
            launches++; throw new Error("must not execute");
        });
        if (mode === "forbidden") ctx.tasks = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore, allowAgentTasks: false});
        ctx.subagentLauncher = createSubagentLauncher({parentContext: ctx, getHistory: () => []});
        try {
            const result = await executeToolResult("agent", JSON.stringify({description: "inspect", prompt: "inspect"}), ctx, "spawn");
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).toContain("does not support");
            expect(launches).toBe(0);
        } finally {await runtime.close();}
    });
});

test("Agent-only final join yields on its window and requires actual result integration", async () => {
    await withTempProject(async cwd => {
        const gate = latch();
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, (options, request) => ({agentId: options.agentId,
            async close() {}, async run() {
                await gate.promise;
                return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                    reply: "child verification complete", reason: "completed", iterations: 1, toolUseCount: 0, durationMs: 1};
            }}));
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks});
        ctx.subagentLauncher = createSubagentLauncher({parentContext: ctx, getHistory: () => []});
        const schedule = globalThis.setTimeout;
        const timer = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(schedule, {
            apply(target, thisArg, args: unknown[]) {
                const [handler, delay, ...rest] = args;
                return Reflect.apply(target, thisArg, [handler, delay === 30_000 ? 5 : delay, ...rest]);
            },
        }));
        const fake = createFakeLLM([
            assistantToolCall("agent", {description: "inspect", prompt: "inspect"}, "spawn"),
            assistantText("Premature success."),
            async options => {
                expect(JSON.stringify(options.messages)).toContain("task result wait window elapsed");
                const task = (await tasks.list())[0]!;
                expect(task.status).toBe("running");
                gate.resolve();
                await waitForTaskCompletion(tasks, [task.id], ctx.signal, "agent");
                return assistantToolCall("task", {action: "wait", task_id: task.id}, "receive");
            },
            options => {
                expect(JSON.stringify(options.messages)).toContain("child verification complete");
                return assistantText("Integrated the verified result.");
            },
        ]);
        const finals: string[] = [];
        try {
            const result = await runAgentForTest("work", [{role: "system", content: "fixture"}], event => {
                if (event.type === "assistant_text" && event.phase === "final") finals.push(event.content);
            }, ctx, {callLLM: fake.callLLM});
            expect(result.reason).toBe("completed");
            expect(finals).toEqual(["Integrated the verified result."]);
            expect(fake.calls).toHaveLength(4);
        } finally {timer.mockRestore(); gate.resolve(); await runtime.close();}
    });
});

test.each(["session", "runtime"] as const)("%s close during Agent registration leaves no running thread", async owner => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        let threadClosed = false;
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner, (options, request) => ({
            agentId: options.agentId,
            async close() {threadClosed = true;},
            async run(input) {
                if (!input.signal.aborted) await new Promise<void>(resolve => {
                    input.signal.addEventListener("abort", () => resolve(), {once: true});
                });
                return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                    reply: "cancelled by owner", reason: "interrupted", iterations: 0, toolUseCount: 0, durationMs: 0};
            },
        }));
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks});
        let closing: Promise<void> | undefined;
        const unsubscribe = tasks.subscribe(event => {
            if (event.type === "task_started") closing = owner === "session" ? tasks.close() : runtime.close();
        });
        try {
            const started = await tasks.startAgent({request: {agentType: "Worker", description: "work", prompt: "work", parentToolCallId: "spawn"}, parentContext: ctx});
            expect(closing).toBeDefined();
            await closing;
            expect(threadClosed).toBe(true);
            expect(runtime.getRunningSummary().agent).toBe(0);
            expect((await tasks.get(started.id))?.status).toBe("cancelled");
        } finally {unsubscribe(); await tasks.close(); await runtime.close();}
    });
});
