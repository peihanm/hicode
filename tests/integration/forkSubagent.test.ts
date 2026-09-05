import {describe, expect, test} from "bun:test";
import {access, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createDisabledSandboxRuntime} from "../../src/sandbox/index.js";
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

async function git(cwd: string, ...args: string[]): Promise<void> {
    const process = Bun.spawn(["git", "-C", cwd, ...args], {
        stdout: "ignore",
        stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([
        new Response(process.stderr).text(),
        process.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function initializeRepository(cwd: string): Promise<void> {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.name", "Pillar Test");
    await git(cwd, "config", "user.email", "pillar-test@example.com");
    await writeFile(join(cwd, ".gitignore"), ".pillar/worktrees/\n");
    await writeFile(join(cwd, "PILLAR.md"), "只完成被委派的工作。\n");
    await writeFile(join(cwd, "base.txt"), "base\n");
    await git(cwd, "add", ".gitignore", "PILLAR.md", "base.txt");
    await git(cwd, "commit", "-q", "-m", "initial");
}

describe("fork subagent", () => {
    test("Fork 只读 snapshot 引用的父 artifact，缺失结果明确失败", async () => {
        await withTempProject(async cwd => {
            const store = createTestToolResultStore(cwd, "parent");
            const visible = await store.persistText({toolCallId: "log", toolName: "bash", content: `父${"日志".repeat(10_000)}日志全文尾部`});
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
                () => assistantToolCall("read_tool_result", {result_id: visible.resultId, limit: 3}, "read-parent"),
                options => {
                    const result = options.messages.find(m => m.role === "tool" && m.tool_call_id === "read-parent");
                    expect(result?.content).toContain("父");
                    expect(result?.content).toContain("offset=3");
                    return assistantToolCall("read_tool_result", {result_id: visible.resultId, offset: visible.byteLength - 18}, "read-tail");
                },
                options => {
                    expect(options.messages.find(m => m.role === "tool" && m.tool_call_id === "read-tail")?.content).toContain("日志全文尾部");
                    return assistantToolCall("read_tool_result", {result_id: hidden.resultId}, "read-hidden");
                },
                options => {
                    expect(options.messages.find(m => m.role === "tool" && m.tool_call_id === "read-hidden")?.content).toContain("not found");
                    return assistantToolCall("read_tool_result", {result_id: missing.resultId}, "read-missing");
                },
                options => {
                    expect(options.messages.find(m => m.role === "tool" && m.tool_call_id === "read-missing")?.content).toContain("not found");
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
                {role: "user", content: "实现一个前后端 Web 应用，主题为白色"},
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
                        message.content.includes("主题为白色")
                    )).toBe(true);
                    expect(options.tools.map((tool) => tool.function.name)).toEqual([
                        "list_files",
                        "read_file",
                        "grep",
                        "glob",
                        "read_tool_result",
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
                run_in_background: true,
            }), ctx, parentToolCallId);
            expect(launched.outcome).toBe("ok");
            expect(launched.modelContent).toContain("frontend (fork)");
            await completion;

            const [task] = await tasks.list();
            expect(task).toMatchObject({
                kind: "agent",
                agentType: "fork",
                agentName: "frontend",
                status: "completed",
                resultPreview: "frontend 已理解父上下文",
            });
            const notifications = await tasks.claimNotifications();
            expect(notifications[0]?.message).toContain("frontend (fork)");
            await runtime.close();
        });
    });

    test("写型 Fork 只修改独立 Worktree 并保留真实名字", async () => {
        await withTempProject(async (cwd) => {
            const projectsRoot = await mkdtemp(join(tmpdir(), "pillar-fork-worktree-"));
            let runtime: ReturnType<typeof createTaskRuntimeForTest> | undefined;
            try {
                await initializeRepository(cwd);
                const parentToolCallId = "fork-worktree-call";
                const history: Message[] = [
                    {role: "system", content: "root system"},
                    {role: "user", content: "实现前端文件"},
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
                                "read_tool_result",
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
                        isolation: "worktree",
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
                    worktree: {
                        state: "changed",
                        changedFiles: [{
                            path: "fork-feature.txt",
                            kind: "create",
                        }],
                    },
                });
                expect(await access(join(cwd, "fork-feature.txt")).then(
                    () => true,
                    () => false
                )).toBe(false);
                if (task?.kind !== "agent" || !task.worktree) {
                    throw new Error("缺少 Fork Worktree");
                }
                expect(await readFile(
                    join(task.worktree.path, "fork-feature.txt"),
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
            expect(missingName.modelContent).toContain("必须提供 name");

            const foreground = await executeToolResult("agent", JSON.stringify({
                description: "fork",
                prompt: "fork",
                subagent_type: "fork",
                name: "frontend",
            }), ctx, "foreground-fork");
            expect(foreground.outcome).toBe("failed");
            expect(foreground.modelContent).toContain("必须设置 run_in_background=true");
        });
    });
});
