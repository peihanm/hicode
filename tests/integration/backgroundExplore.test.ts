import {describe, expect, test} from "bun:test";
import {createDisabledSandboxRuntime} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {assistantText, createFakeLLM} from "../helpers/fakeLLM.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createSubagentRunnerForTest} from "../helpers/subagent.js";
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
                (options) => createSubagentRunnerForTest({
                    ...options,
                    agentOptions: {callLLM: child.callLLM},
                    toolResultStoreOptions: {pillarHome: `${cwd}/child-results`},
                })
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
            expect(launched.modelContent).toContain("Agent Task 已启动");
            const running = await tasks.list();
            expect(running).toHaveLength(1);
            expect(running[0]).toMatchObject({
                kind: "agent",
                status: "running",
                agentType: "Explore",
            });
            expect(taskRuntime.hasRunningThatBlocksRewind()).toBe(true);

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
                outputResult: {resultId: `task_${running[0]!.id}`},
            });
            expect(await tasks.claimNotifications()).toHaveLength(1);
            expect(await tasks.claimNotifications()).toHaveLength(0);
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
                (options) => createSubagentRunnerForTest({
                    ...options,
                    agentOptions: {callLLM: child.callLLM},
                    toolResultStoreOptions: {pillarHome: `${cwd}/child-results`},
                })
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
            expect(await tasks.claimNotifications()).toHaveLength(0);
            await taskRuntime.close();
        });
    });
});
