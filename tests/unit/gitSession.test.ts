import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import {describe, expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";
import {
    createGitSessionRuntime,
    createGitWorkspaceRuntime,
} from "../../src/git/index.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {loadSession} from "../../src/session/index.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(["git", "-C", cwd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "",
        },
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
    }
    return stdout.trim();
}

async function initializeRepository(cwd: string): Promise<void> {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.name", "Pillar Test");
    await git(cwd, "config", "user.email", "pillar-test@example.com");
    for (const path of ["pre.txt", "mixed.txt", "base.txt"]) {
        await writeFile(join(cwd, path), "base\n");
    }
    await git(cwd, "add", "--", "pre.txt", "mixed.txt", "base.txt");
    await git(cwd, "commit", "-q", "-m", "initial");
}

describe("Git Session baseline", () => {
    test("区分启动前、Pillar 观测、混合与外部来源，并识别 clean", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            await writeFile(join(cwd, "pre.txt"), "pre-existing\n");
            await writeFile(join(cwd, "mixed.txt"), "pre-existing\n");

            const runtime = createGitSessionRuntime({
                cwd,
                workspace: createGitWorkspaceRuntime(cwd, testChildEnvironment),
                resumed: false,
            });
            await runtime.initialize();

            runtime.observePaths(["mixed.txt", "pillar.txt"], cwd);
            await writeFile(join(cwd, "mixed.txt"), "pillar changed too\n");
            await writeFile(join(cwd, "pillar.txt"), "pillar\n");
            await writeFile(join(cwd, "external.txt"), "external\n");

            const result = await runtime.status(new AbortController().signal);
            expect(result.status).toBe("available");
            if (result.status === "unavailable") return;
            const provenance = Object.fromEntries(
                result.snapshot.files.map((file) => [file.path, file.provenance])
            );
            expect(provenance).toMatchObject({
                "pre.txt": "pre-existing",
                "mixed.txt": "mixed",
                "pillar.txt": "pillar-observed",
                "external.txt": "external-or-unknown",
            });
            const diff = await runtime.diff(new AbortController().signal);
            expect(diff.status).toBe("available");
            if (diff.status === "available") {
                expect(diff.snapshot.files.find(
                    (file) => file.status.path === "pillar.txt"
                )?.status.provenance).toBe("pillar-observed");
            }
        });
    });

    test("结构化写工具自动记录 observed path", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            const ctx = createTestContext(cwd);
            await ctx.gitSession?.initialize();
            const written = await executeToolResult(
                "write_file",
                JSON.stringify({path: "created-by-tool.txt", content: "tool\n"}),
                ctx,
                "write-observed"
            );
            expect(written.outcome).toBe("ok");

            const status = await ctx.gitSession!.status(ctx.signal);
            expect(status.status).toBe("available");
            if (status.status === "available") {
                expect(status.snapshot.files.find(
                    (file) => file.path === "created-by-tool.txt"
                )?.provenance).toBe("pillar-observed");
            }
        });
    });

    test("Snapshot/Resume 保留 Baseline，外部 HEAD 变化会 Reconcile", async () => {
        await withTempProject(async (cwd, storage) => {
            await initializeRepository(cwd);
            const runtime = createGitSessionRuntime({
                cwd,
                workspace: createGitWorkspaceRuntime(cwd, testChildEnvironment),
                resumed: false,
            });
            await runtime.initialize();
            runtime.observePaths(["observed.txt"], cwd);
            await writeFile(join(cwd, "observed.txt"), "observed\n");

            await saveSessionSnapshot(storage, {
                cwd,
                model: "glm-test",
                sessionId: "git-session",
                history: [
                    {role: "system", content: "system"},
                    {role: "user", origin: "user" as const, content: "修改 observed"},
                ],
                todos: [],
                permissionMode: "ask",
        collaborationMode: "build",
                gitSession: runtime.getState(),
            });
            const loaded = loadSession(storage, cwd, "git-session", "glm-test");
            expect(loaded?.gitSession?.observedPaths).toContain("observed.txt");

            const resumed = createGitSessionRuntime({
                cwd,
                workspace: createGitWorkspaceRuntime(cwd, testChildEnvironment),
                persistedState: loaded?.gitSession,
                resumed: true,
            });
            await resumed.initialize();
            expect(resumed.getState()?.traceability).toBe("complete");

            await writeFile(join(cwd, "head.txt"), "head\n");
            await git(cwd, "add", "--", "head.txt");
            await git(cwd, "commit", "-q", "-m", "external head");
            const status = await resumed.status(new AbortController().signal);
            expect(status.status).toBe("available");
            expect(resumed.getState()?.lastKnownHeadOid).toBe(
                await git(cwd, "rev-parse", "HEAD")
            );
            expect(resumed.getState()?.diagnostics.at(-1)?.code)
                .toBe("head-changed");
            if (status.status === "available") {
                expect(status.snapshot.files.find(
                    (file) => file.path === "observed.txt"
                )?.provenance).toBe("pillar-observed");
            }
        });
    });

    test("Resume 没有持久化 Baseline 时以当前仓库建立起点", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            await writeFile(join(cwd, "existing.txt"), "existing\n");
            const runtime = createGitSessionRuntime({
                cwd,
                workspace: createGitWorkspaceRuntime(cwd, testChildEnvironment),
                resumed: true,
            });
            await runtime.initialize();
            expect(runtime.getState()?.traceability).toBe("resume-baseline");
            expect(runtime.getState()?.diagnostics.at(-1)?.code)
                .toBe("resume-baseline");
            const status = await runtime.status(new AbortController().signal);
            if (status.status === "available") {
                expect(status.snapshot.files.find(
                    (file) => file.path === "existing.txt"
                )?.provenance).toBe("pre-existing");
            }
        });
    });

    test("Resume 指向不同 Repository 时重建 Baseline", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            const original = createGitSessionRuntime({
                cwd,
                workspace: createGitWorkspaceRuntime(cwd, testChildEnvironment),
                resumed: false,
            });
            await original.initialize();
            const persisted = original.getState()!;
            const resumed = createGitSessionRuntime({
                cwd,
                workspace: createGitWorkspaceRuntime(cwd, testChildEnvironment),
                persistedState: {
                    ...persisted,
                    repositoryIdentity: "/different/repository",
                    repositoryRoot: "/different/repository",
                },
                resumed: true,
            });
            await resumed.initialize();
            const current = await createGitWorkspaceRuntime(
                cwd,
                testChildEnvironment
            ).status(
                new AbortController().signal
            );
            if (current.status === "unavailable") throw new Error(current.message);
            expect(resumed.getState()).toMatchObject({
                repositoryIdentity: current.snapshot.repositoryIdentity,
                traceability: "repository-reset",
            });
            expect(resumed.getState()?.diagnostics.at(-1)?.code)
                .toBe("repository-changed");
        });
    });
});
