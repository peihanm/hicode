import {describe, expect, test} from "bun:test";
import {access, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createDisabledSandboxRuntime} from "../../src/sandbox/index.js";
import {createSubagentRegistry, type AgentDefinition} from "../../src/subagents/index.js";
import {createAgentTool} from "../../src/tools/agent/agent.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {withTempProject} from "../helpers/tempProject.js";
import {attachSubagentLauncher} from "../helpers/subagentLauncher.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(["git", "-C", cwd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
    return stdout.trim();
}

async function initializeRepository(cwd: string): Promise<void> {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.name", "Pillar Test");
    await git(cwd, "config", "user.email", "pillar-test@example.com");
    await writeFile(join(cwd, ".gitignore"), ".pillar/worktrees/\n");
    await writeFile(join(cwd, "PILLAR.md"), "Worktree Agent 必须遵守本项目规则。\n");
    await writeFile(join(cwd, "base.txt"), "base\n");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-q", "-m", "initial");
}

function writerDefinition(): AgentDefinition {
    return {
        agentType: "project-writer",
        whenToUse: "在隔离 Worktree 中实现小型修改",
        systemPrompt: "你是项目写 Agent。",
        allowedTools: ["read_file", "write_file"],
        model: "inherit",
        maxIterations: 6,
        source: "project",
        path: "/fixture/.pillar/agents/project-writer.md",
    };
}

describe("Worktree background Agent", () => {
    test("隔离修改由 Git Commit/cherry-pick 集成，状态和 Diff 实时刷新", async () => {
        await withTempProject(async (cwd) => {
            const projectsRoot = await mkdtemp(join(tmpdir(), "pillar-worktree-test-"));
            let runtime: ReturnType<typeof createTaskRuntimeForTest> | undefined;
            try {
                await initializeRepository(cwd);
                const registry = createSubagentRegistry({
                    definitions: [writerDefinition()],
                    issues: [],
                });
                const child = createFakeLLM([
                    (options) => {
                        const content = options.messages
                            .map((message) => typeof message.content === "string" ? message.content : "")
                            .join("\n");
                        expect(content).toContain("Worktree Agent 必须遵守本项目规则");
                        expect(content).toContain("[Worktree isolation]");
                        return assistantToolCall(
                            "write_file",
                            {path: "feature.txt", content: "isolated change\n"},
                            "worktree-write"
                        );
                    },
                    () => assistantText("已在 Worktree 中完成 feature.txt。"),
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
                        registry,
                        agentOptions: {callLLM: child.callLLM},
                        toolResultStoreOptions: {pillarHome: join(projectsRoot, "child-results")},
                    }, request),
                    projectsRoot,
                    registry
                );
                const rootStore = createTestToolResultStore(cwd, "root-session", {
                    pillarHome: join(projectsRoot, "root-results"),
                });
                const tasks = runtime.forSession({
                    sessionId: "root-session",
                    toolResultStore: rootStore,
                });
                const ctx = createTestContext(cwd, {
                    sessionId: "root-session",
                    tasks,
                    toolResultStore: rootStore,
                    shellRunner,
                });
                attachSubagentLauncher(ctx, async () => {
                    throw new Error("后台 Worktree Agent 不应走同步 runner");
                });
                const toolRuntime = createToolRuntime({
                    toolOverrides: [createAgentTool(registry)],
                });
                let finished!: () => void;
                const completion = new Promise<void>((resolve) => {
                    finished = resolve;
                });
                tasks.subscribe((event) => {
                    if (event.type === "task_finished") finished();
                });
                const launched = await toolRuntime.executeTool(
                    "agent",
                    JSON.stringify({
                        description: "实现隔离文件",
                        prompt: "创建 feature.txt",
                        subagent_type: "project-writer",
                        run_in_background: true,
                        isolation: "worktree",
                    }),
                    ctx,
                    "launch-writer"
                );
                expect(launched.outcome).toBe("ok");
                const [started] = await tasks.list();
                await completion;

                const completed = await tasks.get(started!.id);
                expect(completed).toMatchObject({
                    kind: "agent",
                    status: "completed",
                    worktree: {
                        state: "changed",
                        dirty: true,
                        commitsAhead: 0,
                        changedFiles: [{path: "feature.txt", kind: "create"}],
                    },
                });
                if (completed?.kind !== "agent" || !completed.worktree) {
                    throw new Error("缺少 Worktree snapshot");
                }
                await expect(tasks.send(completed.id, "继续修改"))
                    .rejects.toThrow("Worktree Agent 暂不支持");
                expect(completed.worktree.path).toStartWith(
                    join(await realpath(cwd), ".pillar", "worktrees")
                );
                expect(completed.worktreeDiffResult?.resultId)
                    .toStartWith(`worktree_${completed.id}_`);
                expect(await access(join(cwd, "feature.txt")).then(() => true, () => false))
                    .toBe(false);

                await git(completed.worktree.path, "add", "feature.txt");
                await git(completed.worktree.path, "commit", "-q", "-m", "child result");
                const committed = await tasks.get(completed.id);
                expect(committed).toMatchObject({
                    kind: "agent",
                    worktree: {dirty: false, commitsAhead: 1},
                });
                const childCommit = await git(completed.worktree.path, "rev-parse", "HEAD");
                await git(cwd, "cherry-pick", childCommit);
                expect(await readFile(join(cwd, "feature.txt"), "utf8"))
                    .toBe("isolated change\n");

                const status = await toolRuntime.executeTool(
                    "task",
                    JSON.stringify({action: "status", task_id: completed.id}),
                    ctx,
                    "status-worktree"
                );
                expect(status.modelContent).toContain("Commits ahead of base: 1");
                expect(status.modelContent).toContain("Git integration is not captured");

                const notifications = await tasks.claimNotifications();
                expect(notifications[0]?.message).toContain("Git cherry-pick");
                expect(notifications[0]?.message).toContain("/rewind");
                const discarded = await toolRuntime.executeTool(
                    "task",
                    JSON.stringify({action: "discard", task_id: completed.id}),
                    ctx,
                    "discard-worktree"
                );
                expect(discarded.outcome).toBe("ok");
                expect(discarded.modelContent).toContain("Cleanup: explicit_discard");
                expect(await tasks.get(completed.id)).toMatchObject({
                    worktree: {
                        state: "cleaned",
                        cleanupReason: "explicit_discard",
                    },
                });
                expect(await access(completed.worktree.path).then(() => true, () => false))
                    .toBe(false);
            } finally {
                await runtime?.close();
                await rm(projectsRoot, {recursive: true, force: true});
            }
        });
    });
});
