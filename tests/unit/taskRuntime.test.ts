import {describe, expect, test} from "bun:test";
import {appendFile} from "node:fs/promises";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import type {TaskEventEnvelope} from "../../src/tasks/index.js";
import type {ShellRunnerLike} from "../../src/tools/bash/shellRunner.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {RuntimeMessageQueue} from "../../src/runtime/messageQueue.js";
import {createTaskNotificationDelivery} from "../../src/runtime/taskNotificationDelivery.js";

describe("TaskRuntime", () => {
    for (const outputFailure of [false, true]) {
        test(`shutdown 保留任务记录，正常清理不通知，输出异常仍通知（异常=${outputFailure}）`, async () => {
            await withTempProject(async cwd => {
                let runs = 0;
                const runner: ShellRunnerLike = {sandboxStatus: {kind: "ready", platform: "macos", warnings: []}, async run(request) {
                    runs++;
                    if (!request.signal.aborted) await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), {once: true}));
                    if (outputFailure) throw new Error("output capture failed");
                    await appendFile(request.outputFilePath!, "stopped\n");
                    return {stdout: "", stderr: "", termination: {kind: "aborted", reason: "shutdown"}, outputBytes: 8, outputComplete: true};
                }};
                const store = createTestToolResultStore(cwd, "quiet-shutdown", {pillarHome: `${cwd}/tool-results`});
                const runtime = createTaskRuntimeForTest(cwd, runner);
                const session = runtime.forSession({sessionId: "quiet-shutdown", toolResultStore: store});
                const task = await session.startShell({command: "fixture-server", cwd, toolCallId: "start-server"});
                await runtime.close();
                expect(await session.pendingNotifications()).toHaveLength(outputFailure ? 1 : 0);
                const restoredRuntime = createTaskRuntimeForTest(cwd, runner);
                try {
                    const restored = restoredRuntime.forSession({sessionId: "quiet-shutdown", toolResultStore: store});
                    expect(await restored.get(task.id)).toMatchObject({status: "cancelled"});
                    if (!outputFailure) expect(await restored.get(task.id)).toMatchObject({output: "stopped\n", termination: {kind: "aborted", reason: "shutdown"}});
                    const queue = new RuntimeMessageQueue();
                    const shown: string[] = [];
                    const delivery = createTaskNotificationDelivery({tasks: restored, queue, async persist() {}, onQueued: item => {shown.push(item.taskId);}});
                    await delivery.drain(); await delivery.drain();
                    expect(shown).toHaveLength(outputFailure ? 1 : 0);
                    expect(queue.list()).toHaveLength(outputFailure ? 1 : 0);
                    expect(runs).toBe(1);
                } finally {await restoredRuntime.close();}
            });
        });
    }
    test("并发启动在异步准备期也不会突破 Session Agent 上限", async () => {
        await withTempProject(async (cwd) => {
            const shellRunner: ShellRunnerLike = {
                sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
                async run() {
                    throw new Error("不应执行 Shell");
                },
            };
            let created = 0;
            const runtime = createTaskRuntimeForTest(
                cwd,
                shellRunner,
                (options, request) => {
                    created += 1;
                    return {
                        agentId: options.agentId,
                        async run(input) {
                            await new Promise<void>((resolve) => {
                                input.signal.addEventListener("abort", () => resolve(), {
                                    once: true,
                                });
                            });
                            return {
                                agentId: options.agentId,
                                agentType: request.agentType,
                                description: request.description,
                                reply: "",
                                reason: "interrupted",
                                iterations: 0,
                                toolUseCount: 0,
                                durationMs: 0,
                            };
                        },
                    };
                }
            );
            const session = runtime.forSession({
                sessionId: "concurrent-agent-session",
                toolResultStore: createTestToolResultStore(
                    cwd,
                    "concurrent-agent-session",
                    {pillarHome: `${cwd}/tool-results`}
                ),
            });
            const context = createTestContext(cwd, {tasks: session});
            const starts = Array.from({length: 5}, (_, index) =>
                session.startAgent({
                    request: {
                        kind: "registered",
                        agentType: "Explore",
                        description: `并发调查 ${index}`,
                        prompt: "等待 Runtime 关闭",
                        parentToolCallId: `concurrent-agent-${index}`,
                    },
                    parentContext: context,
                })
            );

            const settled = await Promise.allSettled(starts);
            expect(settled.filter((result) => result.status === "fulfilled"))
                .toHaveLength(4);
            const rejected = settled.find((result) => result.status === "rejected");
            expect(rejected?.status === "rejected" ? rejected.reason : undefined)
                .toEqual(expect.objectContaining({
                    message: expect.stringContaining("已达到上限 4"),
                }));
            expect(created).toBe(4);
            expect(session.getRunningSummary()).toEqual({
                total: 4,
                shell: 0,
                agent: 4, memory: 0,
            });
            await runtime.close();
        });
    });

    test("已删除的 GeneralPurpose 不能作为后台 Agent 启动", async () => {
        await withTempProject(async (cwd) => {
            const shellRunner: ShellRunnerLike = {
                sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
                async run() {
                    throw new Error("不应执行 Shell");
                },
            };
            const runtime = createTaskRuntimeForTest(cwd, shellRunner);
            const store = createTestToolResultStore(cwd, "policy-session", {
                pillarHome: `${cwd}/tool-results`,
            });
            const session = runtime.forSession({
                sessionId: "policy-session",
                toolResultStore: store,
            });
            const context = createTestContext(cwd, {tasks: session});
            await expect(session.startAgent({
                request: {
                    kind: "registered",
                    agentType: "GeneralPurpose",
                    description: "不允许的后台实现",
                    prompt: "验证项目",
                    parentToolCallId: "policy-call",
                },
                parentContext: context,
            })).rejects.toThrow("未知 Agent 类型");
            await runtime.close();
        });
    });

    test("按 Root 与 Session 汇总仍在运行的后台 Shell", async () => {
        await withTempProject(async (cwd) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const shellRunner: ShellRunnerLike = {
                sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
                async run(request) {
                    await gate;
                    return {
                        stdout: "",
                        stderr: "",
                        termination: {kind: "exit", code: 0, signal: null},
                        outputFilePath: request.outputFilePath,
                        outputBytes: 0,
                        outputComplete: true,
                    };
                },
            };
            const runtime = createTaskRuntimeForTest(cwd, shellRunner);
            const first = runtime.forSession({
                sessionId: "summary-a",
                toolResultStore: createTestToolResultStore(cwd, "summary-a", {
                    pillarHome: `${cwd}/tool-results`,
                }),
            });
            const second = runtime.forSession({
                sessionId: "summary-b",
                toolResultStore: createTestToolResultStore(cwd, "summary-b", {
                    pillarHome: `${cwd}/tool-results`,
                }),
            });
            let finish!: () => void;
            const finished = new Promise<void>((resolve) => {
                finish = resolve;
            });
            first.subscribe((event) => {
                if (event.type === "task_finished") finish();
            });

            await first.startShell({
                command: "node server.js",
                cwd,
                toolCallId: "summary-call",
            });

            expect(first.getRunningSummary()).toEqual({
                total: 1,
                shell: 1,
                agent: 0, memory: 0,
            });
            expect(second.getRunningSummary()).toEqual({
                total: 0,
                shell: 0,
                agent: 0, memory: 0,
            });
            expect(runtime.getRunningSummary()).toEqual({
                total: 1,
                shell: 1,
                agent: 0, memory: 0,
            });

            release();
            await finished;
            expect(first.getRunningSummary()).toEqual({
                total: 0,
                shell: 0,
                agent: 0, memory: 0,
            });
            await runtime.close();
        });
    });

    test("按 Session 隔离任务、发布递增事件并只领取一次通知", async () => {
        await withTempProject(async (cwd) => {
            const shellRunner: ShellRunnerLike = {
                sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
                async run(request) {
                    await new Promise((resolve) => setTimeout(resolve, 650));
                    await appendFile(request.outputFilePath!, "task output\n");
                    return {
                        stdout: "",
                        stderr: "",
                        termination: {kind: "exit", code: 0, signal: null},
                        outputFilePath: request.outputFilePath,
                        outputBytes: 12,
                        outputComplete: true,
                    };
                },
            };
            const runtime = createTaskRuntimeForTest(cwd, shellRunner);
            const firstStore = createTestToolResultStore(cwd, "session-a", {
                pillarHome: `${cwd}/tool-results`,
            });
            const secondStore = createTestToolResultStore(cwd, "session-b", {
                pillarHome: `${cwd}/tool-results`,
            });
            const first = runtime.forSession({
                sessionId: "session-a",
                toolResultStore: firstStore,
            });
            const second = runtime.forSession({
                sessionId: "session-b",
                toolResultStore: secondStore,
            });
            const events: TaskEventEnvelope[] = [];
            let finish!: () => void;
            const finished = new Promise<void>((resolve) => {
                finish = resolve;
            });
            const unsubscribe = first.subscribe((event) => {
                events.push(event);
                if (event.type === "task_finished") finish();
            });

            const started = await first.startShell({
                command: "fixture",
                cwd,
                toolCallId: "task-call",
            });
            await finished;
            const completed = await first.get(started.id);

            expect(completed).toMatchObject({
                status: "completed",
                output: "task output\n",
                outputResult: {resultId: `task_${started.id}`},
            });
            await expect(first.send(started.id, "继续"))
                .rejects.toThrow(`Task ${started.id} 不是 Agent`);
            expect(await second.get(started.id)).toBeUndefined();
            expect(events.map((event) => event.sequence)).toEqual([1, 2]);
            const concurrentClaims = await Promise.all([
                first.pendingNotifications(),
                first.pendingNotifications(),
            ]);
            expect(concurrentClaims.flat()).toHaveLength(2);
            await first.acknowledgeNotification(concurrentClaims[0]![0]!);
            expect(concurrentClaims.flat()[0]).toMatchObject({
                ownerToolCallId: "task-call",
                kind: "shell",
                label: "fixture",
                status: "completed",
                summary: "exit 0",
                resultId: `task_${started.id}`,
            });
            expect(await first.pendingNotifications()).toEqual([]);

            unsubscribe();
            await runtime.close();
        });
    });

    test("失败通知直接携带结构化终止原因和有界错误摘要", async () => {
        await withTempProject(async (cwd) => {
            const shellRunner: ShellRunnerLike = {
                sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
                async run(request) {
                    await new Promise((resolve) => setTimeout(resolve, 650));
                    await appendFile(
                        request.outputFilePath!,
                        "node:events: throw er\nError: listen EADDRINUSE: address already in use :::3000\n"
                    );
                    return {
                        stdout: "",
                        stderr: "",
                        termination: {kind: "exit", code: 1, signal: null},
                        outputFilePath: request.outputFilePath,
                        outputBytes: 83,
                        outputComplete: true,
                    };
                },
            };
            const runtime = createTaskRuntimeForTest(cwd, shellRunner);
            const store = createTestToolResultStore(cwd, "failed-session", {
                pillarHome: `${cwd}/tool-results`,
            });
            const session = runtime.forSession({
                sessionId: "failed-session",
                toolResultStore: store,
            });
            let finish!: () => void;
            const finished = new Promise<void>((resolve) => {
                finish = resolve;
            });
            session.subscribe((event) => {
                if (event.type === "task_finished") finish();
            });
            const started = await session.startShell({
                command: "node server.js",
                cwd,
                toolCallId: "failed-call",
            });
            await finished;

            const [notification] = await session.pendingNotifications();
            expect(notification).toMatchObject({
                taskId: started.id,
                ownerToolCallId: "failed-call",
                kind: "shell",
                label: "node server.js",
                status: "failed",
                resultId: `task_${started.id}`,
            });
            expect(notification?.summary).toContain("exit 1");
            expect(notification?.summary).toContain("EADDRINUSE");
            expect(notification?.message).toContain("EADDRINUSE");
            await runtime.close();
        });
    });

    test("从 Journal 恢复终态任务且不会重跑", async () => {
        await withTempProject(async (cwd) => {
            let runs = 0;
            const shellRunner: ShellRunnerLike = {
                sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
                async run(request) {
                    runs += 1;
                    await new Promise((resolve) => setTimeout(resolve, 650));
                    await appendFile(request.outputFilePath!, "persisted\n");
                    return {
                        stdout: "",
                        stderr: "",
                        termination: {kind: "exit", code: 0, signal: null},
                        outputFilePath: request.outputFilePath,
                        outputBytes: 10,
                        outputComplete: true,
                    };
                },
            };
            const store = createTestToolResultStore(cwd, "resume-session", {
                pillarHome: `${cwd}/tool-results`,
            });
            const firstRuntime = createTaskRuntimeForTest(cwd, shellRunner);
            const first = firstRuntime.forSession({
                sessionId: "resume-session",
                toolResultStore: store,
            });
            let finish!: () => void;
            const finished = new Promise<void>((resolve) => {
                finish = resolve;
            });
            first.subscribe((event) => {
                if (event.type === "task_finished") finish();
            });
            const started = await first.startShell({
                command: "once",
                cwd,
                toolCallId: "resume-call",
            });
            await finished;
            await firstRuntime.close();

            const secondRuntime = createTaskRuntimeForTest(cwd, shellRunner);
            const second = secondRuntime.forSession({
                sessionId: "resume-session",
                toolResultStore: store,
            });
            expect(await second.get(started.id)).toMatchObject({
                id: started.id,
                status: "completed",
                output: "persisted\n",
            });
            expect(runs).toBe(1);
            const pending = await second.pendingNotifications();
            expect(pending).toHaveLength(1);
            await second.acknowledgeNotification(pending[0]!);
            expect(await second.pendingNotifications()).toHaveLength(0);
            await secondRuntime.close();
        });
    });
});
