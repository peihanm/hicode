import {contentText} from "../../src/images/content.js";
import {describe, expect, test} from "bun:test";
import {access, mkdir, mkdtemp, readFile, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import type {Message} from "../../src/llm/types.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {
    assistantText,
    assistantToolCall,
    createFakeLLM,
} from "../helpers/fakeLLM.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {attachSubagentLauncher} from "../helpers/subagentLauncher.js";
import {withTempProject} from "../helpers/tempProject.js";
import {buildForkContextSnapshot} from "../../src/subagents/fork.js";
import {buildPersistedToolResultMessage} from "../../src/toolResults/format.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";

describe("fork subagent", () => {
    test("Fork 只读 snapshot 引用的父 artifact，缺失结果明确失败", async () => {
        await withTempProject(async cwd => {
            const store = createTestToolResultStore(cwd, "parent");
            const visible = await store.persistText({toolCallId: "log", toolName: "bash", content: `父\n${"日志\n".repeat(10_000)}日志全文尾部`});
            const hidden = await store.persistText({toolCallId: "hidden", toolName: "bash", content: "不可继承"});
            const missing = await store.persistText({toolCallId: "missing", toolName: "bash", content: "已丢失"});
            const history: Message[] = [
                {role: "system", content: "root"},
                {role: "assistant", content: null, tool_calls: ["log", "missing"].map(id => ({
                    id, type: "function", function: {name: "bash", arguments: "{}"},
                }))},
                {role: "tool", tool_call_id: "log", content: buildPersistedToolResultMessage(visible)},
                {role: "tool", tool_call_id: "missing", content: buildPersistedToolResultMessage(missing)},
                {role: "assistant", content: null, tool_calls: [{id: "fork", type: "function", function: {name: "agent", arguments: "{}"}}]},
            ];
            const snapshot = buildForkContextSnapshot(history, "fork");
            await store.removeArtifact(missing.resultId);
            const child = createFakeLLM([
                () => assistantToolCall("read_file", {path: visible.path, limit: 1}, "read-parent"),
                options => {
                    const result = options.messages.find(m => m.role === "tool" && m.tool_call_id === "read-parent");
                    expect(result?.content).toContain("父");
                    expect(result?.content).toContain("offset=2");
                    return assistantToolCall("read_file", {path: visible.path, offset: 10002}, "read-tail");
                },
                options => {
                    expect(options.messages.find(m => m.role === "tool" && m.tool_call_id === "read-tail")?.content).toContain("日志全文尾部");
                    return assistantToolCall("read_file", {path: hidden.path}, "read-hidden");
                },
                options => {
                    expect(options.messages.find(m => m.role === "tool" && m.tool_call_id === "read-hidden")?.content).toMatch(/无权|无法验证|ENOENT/);
                    return assistantToolCall("read_file", {path: missing.path}, "read-missing");
                },
                options => {
                    expect(options.messages.find(m => m.role === "tool" && m.tool_call_id === "read-missing")?.content).toMatch(/无权|无法验证|ENOENT/);
                    return assistantText("evidence checked");
                },
                () => assistantText("evidence checked"),
            ]);
            const thread = createSubagentThreadForTest({
                parentContext: createTestContext(cwd, {toolResultStore: store}),
                agentId: "fork-evidence", onEvent: () => {}, agentOptions: {callLLM: child.callLLM},
            }, {kind: "fork", agentType: "fork", name: "evidence", description: "检查证据",
                prompt: "检查证据", parentToolCallId: "fork", contextSnapshot: snapshot});
            const result = await thread.run({prompt: "检查证据", signal: new AbortController().signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL});
            expect(result.reply).toBe("evidence checked");
        });
    });

    test("只读 Fork 继承父对话、使用固定工具集并以具名 Task 返回", async () => {
        await withTempProject(async (cwd) => {
            const parentToolCallId = "fork-frontend-call";
            const history: Message[] = [
                {role: "system", content: "root system"},
                {role: "user", origin: "user" as const, content: "实现一个前后端 Web 应用，主题为白色"},
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [{
                        id: parentToolCallId,
                        type: "function",
                        function: {
                            name: "agent",
                            arguments: JSON.stringify({
                                subagent_type: "fork",
                                name: "frontend",
                            }),
                        },
                    }],
                },
            ];
            const child = createFakeLLM([
                (options) => {
                    expect(options.messages.some((message) =>
                        message.role === "user" &&
                        contentText(message.content).includes("主题为白色")
                    )).toBe(true);
                    expect(options.tools.map((tool) => tool.function.name)).toEqual([
                        "list_files",
                        "read_file",
                        "grep",
                        "glob",
                    ]);
                    return assistantText("frontend 已理解父上下文");
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
            const store = createTestToolResultStore(cwd, "fork-session", {
                pillarHome: `${cwd}/root-results`,
            });
            const tasks = runtime.forSession({
                sessionId: "fork-session",
                toolResultStore: store,
            });
            const ctx = createTestContext(cwd, {tasks, shellRunner});
            attachSubagentLauncher(ctx, async () => {
                throw new Error("Fork 必须走后台 Task runner");
            }, () => history);

            let finished!: () => void;
            const completion = new Promise<void>((resolve) => {
                finished = resolve;
            });
            tasks.subscribe((event) => {
                if (event.type === "task_finished") finished();
            });
            const launched = await executeToolResult("agent", JSON.stringify({
                description: "实现前端",
                prompt: "只调查现有前端结构并给出方案",
                subagent_type: "fork",
                name: "frontend",
                read_only: true,
                run_in_background: true,
            }), ctx, parentToolCallId);
            expect(launched.outcome).toBe("ok");
            expect(launched.modelContent).toContain("frontend");
            await completion;

            const [task] = await tasks.list();
            expect(task).toMatchObject({
                kind: "agent",
                agentType: "fork",
                agentName: "frontend",
                status: "completed",
                resultPreview: "frontend 已理解父上下文",
            });
            const notifications = await tasks.pendingNotifications();
            expect(notifications[0]?.message).toContain("frontend");
            await runtime.close();
        });
    });

    test("写型 Fork 使用普通 cwd，无 Git 项目也可修改并保留真实名字", async () => {
        await withTempProject(async (cwd) => {
            const projectsRoot = await mkdtemp(join(tmpdir(), "pillar-fork-worktree-"));
            let runtime: ReturnType<typeof createTaskRuntimeForTest> | undefined;
            try {
                const childCwd = join(cwd, "worker");
                await mkdir(childCwd);
                const parentToolCallId = "fork-worktree-call";
                const history: Message[] = [
                    {role: "system", content: "root system"},
                    {role: "user", origin: "user" as const, content: "实现前端文件"},
                    {
                        role: "assistant",
                        content: null,
                        tool_calls: [{
                            id: parentToolCallId,
                            type: "function",
                            function: {name: "agent", arguments: "{}"},
                        }],
                    },
                ];
                const child = createFakeLLM([
                    (options) => {
                        expect(options.tools.map((tool) => tool.function.name).sort())
                            .toEqual([
                                "list_files",
                                "glob",
                                "read_file",
                                "grep",
                                "edit_file",
                                "write_file",
                                "delete_file",
                                "bash",
                            ].sort());
                        return assistantToolCall(
                            "write_file",
                            {
                                path: "fork-feature.txt",
                                content: "isolated fork change\n",
                            },
                            "fork-write"
                        );
                    },
                    (options) => {
                        expect(options.messages.find((message) =>
                            message.role === "tool" &&
                            message.tool_call_id === "fork-write"
                        )?.content).toContain("已写入 fork-feature.txt");
                        return assistantText("frontend Fork 已完成文件修改");
                    },
                ]);
                const shellRunner = createShellRunner(
                    createDisabledSandboxRuntime(),
                    testChildEnvironment
                );
                runtime = createTaskRuntimeForTest(
                    cwd,
                    shellRunner,
                    (options, request) => createSubagentThreadForTest({
                        ...options,
                        agentOptions: {callLLM: child.callLLM},
                        toolResultStoreOptions: {
                            pillarHome: join(projectsRoot, "child-results"),
                        },
                    }, request),
                    projectsRoot
                );
                const store = createTestToolResultStore(cwd, "fork-worktree", {
                    pillarHome: join(projectsRoot, "root-results"),
                });
                const tasks = runtime.forSession({
                    sessionId: "fork-worktree",
                    toolResultStore: store,
                });
                const ctx = createTestContext(cwd, {
                    sessionId: "fork-worktree",
                    tasks,
                    toolResultStore: store,
                    shellRunner,
                });
                attachSubagentLauncher(ctx, async () => {
                    throw new Error("Fork 必须走后台 Task runner");
                }, () => history);

                let finished!: () => void;
                const completion = new Promise<void>((resolve) => {
                    finished = resolve;
                });
                tasks.subscribe((event) => {
                    if (event.type === "task_finished") finished();
                });
                const launched = await executeToolResult(
                    "agent",
                    JSON.stringify({
                        description: "实现前端文件",
                        prompt: "创建 fork-feature.txt",
                        subagent_type: "fork",
                        name: "frontend",
                        run_in_background: true,
                        cwd: childCwd,
                    }),
                    ctx,
                    parentToolCallId
                );
                expect(launched.outcome).toBe("ok");
                await completion;

                const [task] = await tasks.list();
                expect(task).toMatchObject({
                    kind: "agent",
                    agentType: "fork",
                    agentName: "frontend",
                    status: "completed",
                    cwd: await realpath(childCwd),
                });
                expect(await access(join(cwd, "fork-feature.txt")).then(
                    () => true,
                    () => false
                )).toBe(false);
                expect(await readFile(
                    join(childCwd, "fork-feature.txt"),
                    "utf8"
                )).toBe("isolated fork change\n");
            } finally {
                await runtime?.close();
                await rm(projectsRoot, {recursive: true, force: true});
            }
        });
    });

    test("Fork 缺少 name 或请求前台运行时在工具边界拒绝", async () => {
        await withTempProject(async (cwd) => {
            const ctx = createTestContext(cwd);
            attachSubagentLauncher(ctx, async () => {
                throw new Error("不应启动");
            });
            const missingName = await executeToolResult("agent", JSON.stringify({
                description: "fork",
                prompt: "fork",
                subagent_type: "fork",
                run_in_background: true,
            }), ctx, "missing-name");
            expect(missingName.outcome).toBe("failed");
            expect(missingName.modelContent).toContain("需要 name");

            const foreground = await executeToolResult("agent", JSON.stringify({
                description: "fork",
                prompt: "fork",
                subagent_type: "fork",
                name: "frontend",
            }), ctx, "foreground-fork");
            expect(foreground.outcome).toBe("failed");
            expect(foreground.modelContent).toContain("run_in_background=true");
        });
    });
});
