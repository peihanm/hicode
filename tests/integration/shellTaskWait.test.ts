import {expect, spyOn, test} from "bun:test";
import {appendFile} from "node:fs/promises";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";
import {RuntimeMessageQueue} from "../../src/runtime/messageQueue.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {childTaskTool, taskTool} from "../../src/tools/task/task.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";
import {runAgentForTest} from "../helpers/agent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";

test("Shell wait expiry returns control, preserves the process and can be followed by another wait or stop", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks});
        try {
            const target = await tasks.startShell({command: "sleep 30", cwd, toolCallId: "job"});
            for (const index of [1, 2]) {
                const result = await executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id, wait_ms: 5}), ctx, `wait-${index}`);
                expect(result.outcome).toBe("ok");
                expect(result.completedTask).toBeUndefined();
                expect(result.modelContent).toContain("Wait window elapsed");
                expect(result.modelContent).toContain("(no new output)");
                expect(result.modelContent).not.toContain("New input is available");
                expect((await tasks.get(target.id))?.status).toBe("running");
                expect(await tasks.pendingNotifications()).toHaveLength(0);
            }
            expect((await executeToolResult("task", JSON.stringify({action: "stop", task_id: target.id}), ctx, "stop")).outcome).toBe("ok");
            expect((await tasks.get(target.id))?.status).toBe("cancelled");
        } finally {await runtime.close();}
    });
});

test("a running wait reports only new capture bytes and keeps Session/child ownership checks", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        let releaseOutput = () => {};
        const outputGate = new Promise<void>(resolve => {releaseOutput = resolve;});
        let outputWritten = () => {};
        const written = new Promise<void>(resolve => {outputWritten = resolve;});
        const runner: ShellRunnerLike = {sandboxStatus: base.shellRunner.sandboxStatus, async run(request) {
            request.onStarted?.();
            await appendFile(request.outputFilePath!, "old-output\n");
            await outputGate;
            await appendFile(request.outputFilePath!, "fresh-output\n");
            outputWritten();
            if (!request.signal.aborted) await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), {once: true}));
            return {stdout: "", stderr: "", termination: {kind: "aborted", reason: "shutdown"}};
        }};
        const runtime = createTaskRuntimeForTest(cwd, runner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const child = tasks.createChildShellSession(createTestToolResultStore(cwd, "wait-child"));
        const read = tasks.readShellOutput.bind(tasks);
        const captured = spyOn(tasks, "readShellOutput").mockImplementation(async (id, offset) => {
            const chunk = await read(id, offset);
            if (offset === 0) {releaseOutput(); await written;}
            return chunk;
        });
        try {
            const target = await tasks.startShell({command: "fixture", cwd, toolCallId: "job"});
            const foreign = runtime.forSession({sessionId: "other", toolResultStore: createTestToolResultStore(cwd, "other")});
            expect(await foreign.readShellOutput(target.id, 0)).toBeUndefined();
            expect(await child.tasks.readShellOutput(target.id, 0)).toBeUndefined();
            const result = await executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id, wait_ms: 5}), {...base, tasks}, "wait");
            expect(result.outcome).toBe("ok");
            expect(result.modelContent).toContain("fresh-output");
            expect(result.modelContent).not.toContain("old-output");
            await expect(read(target.id, -1)).rejects.toThrow("Invalid Shell output cursor");
        } finally {releaseOutput(); captured.mockRestore(); await child.close(); await runtime.close();}
    });
});

test("wait window schema rejects invalid limits and unrelated actions without changing tasks", async () => {
    for (const wait_ms of [0, -1, 1.5, 300_001]) {
        expect(taskTool.parameters.safeParse({action: "wait", task_id: "t_123456789abc", wait_ms}).success).toBe(false);
    }
    expect(taskTool.parameters.safeParse({action: "wait", task_id: "t_123456789abc", wait_ms: 300_000}).success).toBe(true);
    expect(childTaskTool(taskTool).parameters.safeParse({action: "wait", task_id: "t_123456789abc", wait_ms: 10}).success).toBe(true);
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        try {
            for (const action of ["wait", "list", "status"]) {
                const result = await executeToolResult("task", JSON.stringify({action, wait_ms: 10}), {...base, tasks}, action);
                expect(result.outcome).toBe("failed");
                expect(result.modelContent).toContain("explicit Shell task_id");
            }
            expect(await tasks.list()).toHaveLength(0);
        } finally {await runtime.close();}
    });
});

test("the final-answer Shell join also returns control instead of silently waiting forever", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd, {permissionMode: "full-access"});
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks, permissionMode: "full-access"});
        const schedule = globalThis.setTimeout;
        // Exercise the real default window without a 30-second wall-clock test.
        const timer = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(schedule, {
            apply(target, thisArg, args: unknown[]) {
                const [handler, delay, ...rest] = args;
                return Reflect.apply(target, thisArg, [handler, delay === 30_000 ? 1 : delay, ...rest]);
            },
        }));
        const fake = createFakeLLM([
            assistantToolCall("bash", {command: "sleep 30", yield_time_ms: 100}, "start"),
            assistantText("premature final"),
            async options => {
                expect(JSON.stringify(options.messages)).toContain("Shell join wait window elapsed");
                const target = (await tasks.list())[0]!;
                expect(target.status).toBe("running");
                return assistantToolCall("task", {action: "stop", task_id: target.id}, "stop");
            },
            assistantText("Stopped the unnecessary command."),
        ]);
        try {
            expect((await runAgentForTest("work", [{role: "system", content: "fixture"}], () => {}, ctx, {callLLM: fake.callLLM})).reason).toBe("completed");
            expect(fake.calls).toHaveLength(4);
        } finally {timer.mockRestore(); await runtime.close();}
    });
});

test("Shell wait returns real output/exit and excludes unrelated services and Agent joins", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const ctx = createTestContext(cwd, {tasks});
        try {
            await tasks.startShell({command: "sleep 30", cwd, toolCallId: "service"});
            const empty = await executeToolResult("task", '{"action":"wait"}', ctx, "empty");
            expect(empty.modelContent).toContain("No delegated");
            const target = await tasks.startShell({command: "printf once; sleep 0.1; printf done; exit 7", cwd, toolCallId: "job"});
            const result = await executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id}), ctx, "wait");
            expect(result.outcome).toBe("failed");
            expect(result.modelContent).toContain("exit code 7");
            expect(result.modelContent).toContain("oncedone");
            expect((await tasks.get(target.id))?.status).toBe("failed");
            expect((await tasks.list()).filter(t => t.status === "running")).toHaveLength(1);
        } finally {await runtime.close();}
    });
});

test("cancelling Shell wait preserves the running process and later results", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        try {
            const target = await tasks.startShell({command: "sleep 30", cwd, toolCallId: "job"});
            const controller = new AbortController();
            const ctx = createTestContext(cwd, {tasks, signal: controller.signal});
            const waiting = executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id}), ctx, "wait");
            controller.abort("user-cancel");
            expect((await waiting).outcome).toBe("interrupted");
            expect((await tasks.get(target.id))?.status).toBe("running");
            await tasks.stop(target.id);
            const result = await executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id}), {...base, tasks}, "after-stop");
            expect(result.modelContent).toContain("Termination:");
        } finally {await runtime.close();}
    });
});

test("child wait exposes only its owned Shell task", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const parent = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore});
        const child = parent.createChildShellSession(createTestToolResultStore(cwd, "child")).tasks;
        const ctx = createTestContext(cwd);
        ctx.tasks = child;
        try {
            const foreign = await parent.startShell({command: "sleep 30", cwd, toolCallId: "foreign"});
            const own = await child.startShell({command: "sleep 0.1; printf child", cwd, toolCallId: "own"});
            expect(childTaskTool(taskTool).parameters.safeParse({action: "wait", task_id: own.id}).success).toBe(true);
            expect((await executeToolResult("task", JSON.stringify({action: "wait", task_id: foreign.id}), ctx, "foreign-wait")).outcome).toBe("failed");
            expect((await executeToolResult("task", JSON.stringify({action: "wait", task_id: own.id}), ctx, "own-wait")).modelContent).toContain("child");
        } finally {await runtime.close();}
    });
});

test("Shell wait wakes for user input without consuming it or stopping the process", async () => {
    await withTempProject(async cwd => {
        const base = createTestContext(cwd);
        const queue = new RuntimeMessageQueue();
        const runtime = createTaskRuntimeForTest(cwd, base.shellRunner);
        const tasks = runtime.forSession({sessionId: base.sessionId, toolResultStore: base.toolResultStore, messageQueue: queue});
        const ctx = createTestContext(cwd, {tasks});
        ctx.agentMessaging = tasks.messaging;
        try {
            const target = await tasks.startShell({command: "sleep 30", cwd, toolCallId: "job"});
            const waiting = executeToolResult("task", JSON.stringify({action: "wait", task_id: target.id}), ctx, "wait");
            queue.enqueueUser("new requirement");
            const result = await waiting;
            expect(result.modelContent).toContain("New input is available");
            expect((await tasks.get(target.id))?.status).toBe("running");
            expect(queue.createAgentInputChannel(() => {}).drainSafeBoundary()).toHaveLength(1);
        } finally {await runtime.close();}
    });
});
