import {describe, expect, test} from "bun:test";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {
    assistantText,
    assistantToolCall,
    createFakeLLM,
} from "../helpers/fakeLLM.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {withTempProject} from "../helpers/tempProject.js";
import {attachSubagentLauncher} from "../helpers/subagentLauncher.js";

describe("background Explore", () => {
    test("Agent Tool 立即返回，后台结果进入 Task 并只通知一次", async () => {
        await withTempProject(async (cwd) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const child = createFakeLLM([
                async () => {
                    await gate;
                    return assistantText("后台调查报告");
                },
            ]);
            const shellRunner = createShellRunner(
                createDisabledSandboxRuntime(),
                testChildEnvironment
            );
            const taskRuntime = createTaskRuntimeForTest(
                cwd,
                shellRunner,
                (options, request) => createSubagentThreadForTest({
                    ...options,
                    agentOptions: {callLLM: child.callLLM},
                    toolResultStoreOptions: {pillarHome: `${cwd}/child-results`},
                }, request)
            );
            const store = createTestToolResultStore(cwd, "root-session", {
                pillarHome: `${cwd}/root-results`,
            });
            const tasks = taskRuntime.forSession({
                sessionId: "root-session",
                toolResultStore: store,
            });
            const ctx = createTestContext(cwd, {tasks});
            attachSubagentLauncher(ctx, async () => {
                throw new Error("后台 Explore 不应走同步 runner");
            });

            const launched = await executeToolResult("agent", JSON.stringify({
                description: "后台调查",
                prompt: "调查代码结构",
                subagent_type: "Explore",
                run_in_background: true,
            }), ctx, "background-agent-call");
            expect(launched.outcome).toBe("ok");
            expect(launched.modelContent).toContain("Agent Task started");
            const running = await tasks.list();
            expect(running).toHaveLength(1);
            expect(running[0]).toMatchObject({
                kind: "agent",
                status: "running",
                agentType: "Explore",
            });

            let finish!: () => void;
            const finished = new Promise<void>((resolve) => {
                finish = resolve;
            });
            tasks.subscribe((event) => {
                if (event.type === "task_finished") finish();
            });
            release();
            await finished;

            const completed = await tasks.get(running[0]!.id);
            expect(completed).toMatchObject({
                kind: "agent",
                status: "completed",
                resultPreview: "后台调查报告",
                outputResult: {resultId: `task_${running[0]!.id}_run_1`},
            });
            const pending = await tasks.pendingNotifications();
            expect(pending).toHaveLength(1);
            await tasks.acknowledgeNotification(pending[0]!);
            expect(await tasks.pendingNotifications()).toHaveLength(0);
            await taskRuntime.close();
        });
    });

    test("Root Turn 取消不停止后台 Agent，task stop 取消目标且消费终态通知", async () => {
        await withTempProject(async (cwd) => {
            let markStarted!: () => void;
            const llmStarted = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            const child = createFakeLLM([
                async (options) => {
                    markStarted();
                    await new Promise<never>((_resolve, reject) => {
                        options.signal?.addEventListener(
                            "abort",
                            () => reject(new Error("task signal aborted")),
                            {once: true}
                        );
                    });
                    throw new Error("unreachable");
                },
            ]);
            const shellRunner = createShellRunner(
                createDisabledSandboxRuntime(),
                testChildEnvironment
            );
            const taskRuntime = createTaskRuntimeForTest(
                cwd,
                shellRunner,
                (options, request) => createSubagentThreadForTest({
                    ...options,
                    agentOptions: {callLLM: child.callLLM},
                    toolResultStoreOptions: {pillarHome: `${cwd}/child-results`},
                }, request)
            );
            const store = createTestToolResultStore(cwd, "root-session", {
                pillarHome: `${cwd}/root-results`,
            });
            const tasks = taskRuntime.forSession({
                sessionId: "root-session",
                toolResultStore: store,
            });
            const parent = new AbortController();
            const ctx = createTestContext(cwd, {
                tasks,
                signal: parent.signal,
            });
            attachSubagentLauncher(ctx, async () => {
                throw new Error("后台 Explore 不应走同步 runner");
            });

            await executeToolResult("agent", JSON.stringify({
                description: "等待取消",
                prompt: "持续调查直到被停止",
                subagent_type: "Explore",
                run_in_background: true,
            }), ctx, "background-stop-call");
            await llmStarted;
            const [running] = await tasks.list();
            parent.abort("user-cancel");
            expect((await tasks.get(running!.id))?.status).toBe("running");

            const stopped = await tasks.stop(running!.id);
            expect(stopped).toMatchObject({
                kind: "agent",
                status: "cancelled",
            });
            await expect(tasks.send(running!.id, "取消后继续"))
                .rejects.toThrow("cancelled Agent cannot continue");
            expect(await tasks.pendingNotifications()).toHaveLength(0);
            await taskRuntime.close();
        });
    });

    test("运行中消息在 Tool Batch 后进入同一 Agent History", async () => {
        await withTempProject(async (cwd) => {
            let markStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const child = createFakeLLM([
                async () => {
                    markStarted();
                    await gate;
                    return assistantToolCall(
                        "list_files",
                        {path: "."},
                        "queued-input-boundary"
                    );
                },
                (options) => {
                    const queued = options.messages.find((message) =>
                        message.role === "user" &&
                        typeof message.content === "string" &&
                        message.content.includes("重点检查消息队列")
                    );
                    expect(queued).toBeDefined();
                    expect(options.messages.some((message) =>
                        message.role === "tool" &&
                        message.tool_call_id === "queued-input-boundary"
                    )).toBe(true);
                    return assistantText("已按追加要求完成调查");
                },
            ]);
            const shellRunner = createShellRunner(
                createDisabledSandboxRuntime(),
                testChildEnvironment
            );
            const runtime = createTaskRuntimeForTest(
                cwd,
                shellRunner,
                (options, request) => createSubagentThreadForTest({
                    ...options,
                    agentOptions: {callLLM: child.callLLM},
                    toolResultStoreOptions: {pillarHome: `${cwd}/child-results`},
                }, request)
            );
            const tasks = runtime.forSession({
                sessionId: "message-session",
                toolResultStore: createTestToolResultStore(cwd, "message-session", {
                    pillarHome: `${cwd}/root-results`,
                }),
            });
            const ctx = createTestContext(cwd, {tasks});
            attachSubagentLauncher(ctx, async () => {
                throw new Error("后台 Explore 不应走同步 runner");
            });
            await executeToolResult("agent", JSON.stringify({
                description: "验证运行中消息",
                prompt: "先列出项目文件",
                subagent_type: "Explore",
                run_in_background: true,
            }), ctx, "running-message-call");
            await started;
            const [task] = await tasks.list();
            if (!task || task.kind !== "agent") throw new Error("Agent Task 未启动");
            const queued = await tasks.send(task.id, "请重点检查消息队列");
            expect(queued).toMatchObject({
                id: task.id,
                status: "running",
                progress: {runCount: 1, pendingMessages: 1},
            });

            const finished = new Promise<void>((resolve) => {
                const unsubscribe = tasks.subscribe((event) => {
                    if (event.type !== "task_finished") return;
                    unsubscribe();
                    resolve();
                });
            });
            release();
            await finished;
            expect(await tasks.get(task.id)).toMatchObject({
                status: "completed",
                resultPreview: "已按追加要求完成调查",
                progress: {runCount: 1, pendingMessages: 0},
            });
            await runtime.close();
        });
    });

    test("已完成 Agent 使用相同 ID 和 History 开启下一次 Run", async () => {
        await withTempProject(async (cwd) => {
            const child = createFakeLLM([
                () => assistantText("第一轮报告"),
                (options) => {
                    expect(options.messages.some((message) =>
                        message.role === "assistant" &&
                        message.content === "第一轮报告"
                    )).toBe(true);
                    expect(options.messages.some((message) =>
                        message.role === "user" &&
                        message.content === "继续检查测试覆盖"
                    )).toBe(true);
                    return assistantText("第二轮报告");
                },
            ]);
            const shellRunner = createShellRunner(
                createDisabledSandboxRuntime(),
                testChildEnvironment
            );
            const runtime = createTaskRuntimeForTest(
                cwd,
                shellRunner,
                (options, request) => createSubagentThreadForTest({
                    ...options,
                    agentOptions: {callLLM: child.callLLM},
                    toolResultStoreOptions: {pillarHome: `${cwd}/child-results`},
                }, request)
            );
            const tasks = runtime.forSession({
                sessionId: "continue-session",
                toolResultStore: createTestToolResultStore(cwd, "continue-session", {
                    pillarHome: `${cwd}/root-results`,
                }),
            });
            const ctx = createTestContext(cwd, {tasks});
            attachSubagentLauncher(ctx, async () => {
                throw new Error("后台 Explore 不应走同步 runner");
            });
            let finishedCount = 0;
            let resolveFinished!: () => void;
            let finished = new Promise<void>((resolve) => {
                resolveFinished = resolve;
            });
            tasks.subscribe((event) => {
                if (event.type !== "task_finished") return;
                finishedCount += 1;
                resolveFinished();
            });
            await executeToolResult("agent", JSON.stringify({
                description: "验证完成后继续",
                prompt: "先给出第一轮结论",
                subagent_type: "Explore",
                run_in_background: true,
            }), ctx, "continue-agent-call");
            const [started] = await tasks.list();
            if (!started || started.kind !== "agent") {
                throw new Error("Agent Task 未启动");
            }
            await finished;
            expect(await tasks.get(started.id)).toMatchObject({
                status: "completed",
                resultPreview: "第一轮报告",
                progress: {runCount: 1},
            });

            finished = new Promise<void>((resolve) => {
                resolveFinished = resolve;
            });
            const continued = await executeToolResult(
                "task",
                JSON.stringify({
                    action: "send",
                    task_id: started.id,
                    message: "继续检查测试覆盖",
                }),
                ctx,
                "continue-agent-message"
            );
            expect(continued.outcome).toBe("ok");
            expect(continued.modelContent).toContain(`Task: ${started.id}`);
            expect(continued.modelContent).toContain("Progress: run 2");
            await finished;
            expect(finishedCount).toBe(2);
            expect(await tasks.get(started.id)).toMatchObject({
                id: started.id,
                status: "completed",
                resultPreview: "第二轮报告",
                outputResult: {
                    resultId: `task_${started.id}_run_2`,
                },
                progress: {runCount: 2, pendingMessages: 0},
            });
            const pendingRuns = await tasks.pendingNotifications();
            expect(pendingRuns).toHaveLength(2);
            expect(new Set(pendingRuns.map(item => item.notificationId)).size).toBe(2);
            await runtime.close();
            const restoredRuntime = createTaskRuntimeForTest(cwd, shellRunner);
            const restored = restoredRuntime.forSession({sessionId: "continue-session",
                toolResultStore: createTestToolResultStore(cwd, "continue-session", {pillarHome: `${cwd}/root-results`})});
            try {
                const recovered = await restored.pendingNotifications();
                expect(new Set(recovered.map(item => item.notificationId))).toEqual(new Set(pendingRuns.map(item => item.notificationId)));
                const firstRun = recovered.find(item => item.message.includes("第一轮报告"))!;
                await restored.acknowledgeNotification(firstRun);
                expect((await restored.pendingNotifications()).map(item => item.message)).toEqual([expect.stringContaining("第二轮报告")]);
            } finally { await restoredRuntime.close(); }
        });
    });

    test("进程恢复只保留 archived 状态，不把 transcript 当成可运行 Thread", async () => {
        await withTempProject(async (cwd) => {
            const taskHome = `${cwd}/task-state`;
            const child = createFakeLLM([
                () => assistantText("恢复前报告"),
            ]);
            const shellRunner = createShellRunner(
                createDisabledSandboxRuntime(),
                testChildEnvironment
            );
            const firstRuntime = createTaskRuntimeForTest(
                cwd,
                shellRunner,
                (options, request) => createSubagentThreadForTest({
                    ...options,
                    agentOptions: {callLLM: child.callLLM},
                    toolResultStoreOptions: {pillarHome: `${cwd}/child-results`},
                }, request),
                taskHome
            );
            const store = createTestToolResultStore(cwd, "restore-agent", {
                pillarHome: `${cwd}/root-results`,
            });
            const firstTasks = firstRuntime.forSession({
                sessionId: "restore-agent",
                toolResultStore: store,
            });
            const ctx = createTestContext(cwd, {tasks: firstTasks});
            attachSubagentLauncher(ctx, async () => {
                throw new Error("后台 Explore 不应走同步 runner");
            });
            const finished = new Promise<void>((resolve) => {
                const unsubscribe = firstTasks.subscribe((event) => {
                    if (event.type !== "task_finished") return;
                    unsubscribe();
                    resolve();
                });
            });
            await executeToolResult("agent", JSON.stringify({
                description: "验证 archived 边界",
                prompt: "生成一份报告",
                subagent_type: "Explore",
                run_in_background: true,
            }), ctx, "archived-agent-call");
            const [started] = await firstTasks.list();
            await finished;
            await firstRuntime.close();

            const secondRuntime = createTaskRuntimeForTest(
                cwd,
                shellRunner,
                undefined,
                taskHome
            );
            const restoredTasks = secondRuntime.forSession({
                sessionId: "restore-agent",
                toolResultStore: store,
            });
            await restoredTasks.initialize();
            expect(await restoredTasks.get(started!.id)).toMatchObject({
                kind: "agent",
                status: "completed",
                resultPreview: "恢复前报告",
            });
            await expect(restoredTasks.send(started!.id, "恢复后继续"))
                .rejects.toThrow("has only persisted state");
            await secondRuntime.close();
        });
    });
});
