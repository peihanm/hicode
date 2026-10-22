import {expect, test} from "bun:test";
import {createToolRuntime} from "../../src/tools/runtime.js";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {waitForTaskCompletion} from "../../src/tasks/wait.js";

{
    const toolName = "task";
    test(`${toolName} 默认停止自有任务无需确认，仍尊重规则、模式和 Session 边界`, async () => {
        await withTempProject(async cwd => {
            let approvals = 0;
            const shellRunner: ShellRunnerLike = {
                sandboxStatus: {kind: "ready", networkMode: "restricted", platform: "macos", warnings: []},
                async run(request) {
                    await new Promise<void>(resolve => {
                        if (request.signal.aborted) resolve();
                        else request.signal.addEventListener("abort", () => resolve(), {once: true});
                    });
                    return {stdout: "", stderr: "", termination: {kind: "aborted", reason: "user-cancel"},
                        outputFilePath: request.outputFilePath, outputBytes: 0, outputComplete: true};
                },
            };
            const ctx = createTestContext(cwd, {permissionMode: "ask", shellRunner,
                canUseTool: async () => {
                    approvals++;
                    return {behavior: "deny", message: "test declined"};
                }});
            const runtime = createTaskRuntimeForTest(cwd, shellRunner);
            const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
            ctx.tasks = session;
            const tools = createToolRuntime();
            try {
                const task = await session.startShell({command: "fixture-worker", cwd, toolCallId: "start"});
                const input = JSON.stringify({task_id: task.id, action: "stop"});
                const execute = () => tools.executeTool(toolName, input, ctx, "stop-test");
                const other = createTestContext(cwd, {sessionId: "other", permissionMode: "full-access"});
                other.tasks = runtime.forSession({sessionId: other.sessionId, toolResultStore: other.toolResultStore});
                const hidden = await tools.executeTool(toolName, input, other, "foreign-stop");
                expect(hidden.outcome).toBe("denied");
                expect(hidden.modelContent).toContain("Background task not found");
                expect(hidden.modelContent).not.toContain("fixture-worker");
                expect((await session.get(task.id))?.status).toBe("running");

                ctx.permissionRules.allow.push({toolName, source: "project"});
                ctx.permissionRules.deny.push({toolName, source: "project"});
                expect((await execute()).outcome).toBe("denied");
                expect(approvals).toBe(0);
                ctx.permissionRules.deny = [];
                ctx.permissionRules.ask.push({toolName, source: "project"});
                expect((await execute()).outcome).toBe("denied");
                expect(approvals).toBe(1);
                ctx.permissionRules.ask = [];
                ctx.permissionRules.allow = [];

                Object.assign(ctx, {readOnlyTools: true});
                expect((await execute()).outcome).toBe("denied");
                Object.assign(ctx, {readOnlyTools: false});
                expect(approvals).toBe(1);
                expect((await session.get(task.id))?.status).toBe("running");
                ctx.setPermissionMode("ask");
                const missing = await tools.executeTool(toolName,
                    JSON.stringify({task_id: "missing", action: "stop"}), ctx, "missing-stop");
                expect(missing.outcome).toBe("denied");
                expect(approvals).toBe(1);

                // No interactive Host is needed for the scoped cleanup operation.
                const noninteractive = createTestContext(cwd, {permissionMode: "ask",
                    permissionPromptPolicy: "never", tasks: session, shellRunner});
                expect((await tools.executeTool(toolName, input, noninteractive, "stop-owned")).outcome).toBe("ok");
                expect((await session.get(task.id))?.status).toBe("cancelled");
                expect((await execute()).outcome).toBe("ok");
                expect(approvals).toBe(1);
                expect(await session.pendingNotifications()).toHaveLength(0);
            } finally {
                await runtime.close();
            }
        });
    });
}

test("stopping an already failed Shell succeeds without changing its process result", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner);
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        ctx.tasks = session;
        const tools = createToolRuntime();
        try {
            const task = await session.startShell({command: "printf 'original failure'; exit 7", cwd, toolCallId: "failed-shell"});
            await waitForTaskCompletion(session, [task.id], ctx.signal, "shell");
            expect(await session.pendingNotifications()).toHaveLength(1);
            const args = JSON.stringify({action: "stop", task_id: task.id});
            const stopped = await tools.executeTool("task", args, ctx, "stop-failed");
            expect(stopped.outcome).toBe("ok");
            expect(stopped.modelContent).toContain("Task already finished; no stop needed.");
            expect(stopped.modelContent).toContain("status: failed");
            expect(stopped.modelContent).toContain("exit code 7");
            expect(stopped.modelContent).toContain("original failure");
            expect(await session.get(task.id)).toMatchObject({status: "failed", termination: {kind: "exit", code: 7}});
            expect(await session.pendingNotifications()).toHaveLength(0);
            expect((await tools.executeTool("task", args, ctx, "stop-again")).outcome).toBe("ok");
            const status = await tools.executeTool("task", JSON.stringify({action: "status", task_id: task.id}), ctx, "status-failed");
            expect(status.outcome).toBe("failed");
        } finally {await runtime.close();}
    });
});

test("task 默认停止自有 Agent，已删除的 discard 在 Schema 边界拒绝", async () => {
    await withTempProject(async cwd => {
        let approvals = 0;
        const ctx = createTestContext(cwd, {permissionMode: "ask", canUseTool: async () => {
            approvals++;
            return {behavior: "deny", message: "test declined"};
        }});
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, (options, request) => ({
            agentId: options.agentId,
            async close() {}, async run(input) {
                await new Promise<void>(resolve => {
                    if (input.signal.aborted) resolve();
                    else input.signal.addEventListener("abort", () => resolve(), {once: true});
                });
                return {agentId: options.agentId, agentType: request.agentType,
                    description: request.description, reply: "", reason: "interrupted",
                    iterations: 0, toolUseCount: 0, durationMs: 0};
            },
        }));
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        ctx.tasks = session;
        const tools = createToolRuntime();
        try {
            const task = await session.startAgent({parentContext: ctx, request: {
                 agentType: "Explore", description: "permission test",
                prompt: "wait", parentToolCallId: "agent-start",
            }});
            const stopped = await tools.executeTool("task", JSON.stringify({action: "stop", task_id: task.id}), ctx, "agent-stop");
            expect(stopped.outcome).toBe("ok");
            expect((await session.get(task.id))?.status).toBe("cancelled");
            expect(approvals).toBe(0);
            const discarded = await tools.executeTool("task", JSON.stringify({action: "discard", task_id: task.id}), ctx, "agent-discard");
            expect(discarded.outcome).toBe("failed");
            expect(approvals).toBe(0);
            expect(await session.get(task.id)).toBeDefined();
        } finally {
            await runtime.close();
        }
    });
});
