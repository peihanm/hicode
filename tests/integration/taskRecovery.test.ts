import {expect, test} from "bun:test";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {contentText} from "../../src/images/content.js";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";
import {waitForTaskCompletion} from "../../src/tasks/wait.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

const untilAborted = (signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), {once: true});
});

test.each(["shell", "agent"])("invalid Task IDs prioritize running %s over reviews and completed tasks without executing it", async kind => {
    await withTempProject(async cwd => {
        const shellRunner: ShellRunnerLike = {
            sandboxStatus: {kind: "ready", networkMode: "restricted", platform: "macos", warnings: []},
            async run(request) {
                if (request.command !== "finished") await untilAborted(request.signal);
                return {stdout: "", stderr: "", outputFilePath: request.outputFilePath, outputBytes: 0,
                    outputComplete: true, termination: {kind: "exit", code: 0, signal: null}};
            },
        };
        const ctx = createTestContext(cwd, {shellRunner});
        const runtime = createTaskRuntimeForTest(cwd, shellRunner, (options, request) => ({
            agentId: options.agentId,
            async close() {},
            async run(input) {
                await untilAborted(input.signal);
                return {agentId: options.agentId, agentType: request.agentType, description: request.description,
                    reply: "", reason: "interrupted", iterations: 0, toolUseCount: 0, durationMs: 0};
            },
        }), undefined, undefined, undefined, async () => "Observed progress only.");
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        ctx.tasks = session;
        const tools = createToolRuntime();
        try {
            for (let index = 0; index < 7; index++) {
                await session.startReview({parentContext: ctx, signal: ctx.signal,
                    evidence: {fromRound: 1, toRound: 10, requirements: "Task", activity: "Observed progress"}});
            }
            const completed = await session.startShell({command: "finished", cwd, toolCallId: "finished"});
            await waitForTaskCompletion(session, [completed.id], ctx.signal, "shell");
            const active = kind === "shell"
                ? await session.startShell({command: "pending", cwd, toolCallId: "pending"})
                : await session.startAgent({parentContext: ctx, request: {
                    agentType: "Explore", description: "pending", prompt: "wait", parentToolCallId: "pending",
                }});
            const before = (await session.list()).map(task => task.id);
            for (const id of ["shell-3", "t_ffffffffffff"]) {
                const result = await tools.executeTool("task", JSON.stringify({action: "wait", task_id: id}), ctx, id);
                const message = contentText(result.modelContent);
                expect(result.outcome).toBe("failed");
                expect(message).toContain(`Inspect an existing task: ${JSON.stringify({action: "status", task_id: active.id})}`);
                expect(message.indexOf(active.id)).toBeLessThan(message.indexOf(completed.id));
                expect(message.match(/^task_id:/gm)).toHaveLength(6);
                expect(message).toContain("3 more tasks");
                expect((await session.get(active.id))?.status).toBe("running");
                expect((await session.list()).map(task => task.id)).toEqual(before);
            }
        } finally {await runtime.close();}
    });
});

test("wait recovery never suggests waiting for a review or exposes another Session's task", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const runtime = createTaskRuntimeForTest(cwd, ctx.shellRunner, undefined, undefined, undefined, undefined,
            async () => "Observed progress only.");
        const session = runtime.forSession({sessionId: ctx.sessionId, toolResultStore: ctx.toolResultStore});
        ctx.tasks = session;
        const tools = createToolRuntime();
        try {
            const empty = await tools.executeTool("task", JSON.stringify({action: "wait", task_id: "bad"}), ctx, "empty");
            expect(empty.modelContent).toContain("No accessible tasks");
            expect(empty.modelContent).not.toContain("Inspect an existing task");
            const review = await session.startReview({parentContext: ctx, signal: ctx.signal,
                evidence: {fromRound: 1, toRound: 10, requirements: "Task", activity: "Observed progress"}});
            const other = runtime.forSession({sessionId: "foreign", toolResultStore: createTestToolResultStore(cwd, "foreign")});
            const hidden = await other.startShell({command: "true", cwd, toolCallId: "foreign-shell"});
            const result = await tools.executeTool("task", JSON.stringify({action: "wait", task_id: hidden.id}), ctx, "missing");
            expect(result.modelContent).toContain(review.id);
            expect(result.modelContent).toContain("Review and Memory tasks do not support wait");
            expect(result.modelContent).not.toContain(hidden.id);
            expect(result.modelContent).not.toContain("Inspect an existing task");
        } finally {await runtime.close();}
    });
});
