import {describe, expect, test} from "bun:test";
import {access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createWorktreeRuntime} from "../../src/worktrees/runtime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createPillarStorageLayout} from "../../src/persistence/index.js";
import type {WorktreeRuntimeLike} from "../../src/worktrees/types.js";

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

async function initializeRepository(cwd: string, ignored = true): Promise<void> {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.name", "Pillar Test");
    await git(cwd, "config", "user.email", "pillar-test@example.com");
    await writeFile(join(cwd, "tracked.txt"), "tracked\n");
    if (ignored) await writeFile(join(cwd, ".gitignore"), ".pillar/worktrees/\n");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-q", "-m", "initial");
}

function runtime(cwd: string, storage: string): WorktreeRuntimeLike {
    return createWorktreeRuntime(
        createPillarStorageLayout({pillarHome: storage}),
        cwd,
        testChildEnvironment
    );
}

describe("WorktreeRuntime", () => {
    test("无工作产物时自动清理", async () => {
        await withTempProject(async (cwd) => {
            const storage = await mkdtemp(join(tmpdir(), "pillar-worktree-unit-"));
            try {
                await initializeRepository(cwd);
                const worktrees = runtime(cwd, storage);
                const record = await worktrees.create({
                    taskId: "task-cleanup",
                    sessionId: "session-a",
                    signal: new AbortController().signal,
                });
                const finished = await worktrees.finish(record);
                expect(finished.record).toMatchObject({
                    state: "cleaned",
                    cleanupReason: "no_changes",
                });
                expect(await access(record.path).then(() => true, () => false)).toBe(false);
            } finally {
                await rm(storage, {recursive: true, force: true});
            }
        });
    });

    test("来源工作区可以脏，但未提交内容不会进入 Worktree", async () => {
        await withTempProject(async (cwd) => {
            const storage = await mkdtemp(join(tmpdir(), "pillar-worktree-unit-"));
            try {
                await initializeRepository(cwd);
                await writeFile(join(cwd, "tracked.txt"), "source dirty\n");
                await writeFile(join(cwd, "untracked.txt"), "source only\n");
                const worktrees = runtime(cwd, storage);
                const record = await worktrees.create({
                    taskId: "task-dirty",
                    sessionId: "session-a",
                    signal: new AbortController().signal,
                });
                expect(record.sourceHadChanges).toBe(true);
                expect(await readFile(join(record.path, "tracked.txt"), "utf8")).toBe("tracked\n");
                expect(await access(join(record.path, "untracked.txt")).then(
                    () => true,
                    () => false
                )).toBe(false);
                await worktrees.finish(record);
            } finally {
                await rm(storage, {recursive: true, force: true});
            }
        });
    });

    test("只有新 Commit、Working Tree 干净时仍保留", async () => {
        await withTempProject(async (cwd) => {
            const storage = await mkdtemp(join(tmpdir(), "pillar-worktree-unit-"));
            try {
                await initializeRepository(cwd);
                const worktrees = runtime(cwd, storage);
                const record = await worktrees.create({
                    taskId: "task-commit",
                    sessionId: "session-a",
                    signal: new AbortController().signal,
                });
                await writeFile(join(record.path, "committed.txt"), "result\n");
                await git(record.path, "add", "committed.txt");
                await git(record.path, "commit", "-q", "-m", "child result");
                const finished = await worktrees.finish(record);
                expect(finished.record.state).toBe("changed");
                expect(finished.inspection).toMatchObject({
                    status: "available",
                    dirty: false,
                    commitsAhead: 1,
                    hasWork: true,
                });
                expect(await access(record.path).then(() => true, () => false)).toBe(true);
                await worktrees.discard(finished.record);
            } finally {
                await rm(storage, {recursive: true, force: true});
            }
        });
    });

    test("缺少 ignore 规则或 .pillar 是 symlink 时拒绝创建", async () => {
        await withTempProject(async (cwd) => {
            const storage = await mkdtemp(join(tmpdir(), "pillar-worktree-unit-"));
            try {
                await initializeRepository(cwd, false);
                await expect(runtime(cwd, storage).create({
                    taskId: "task-no-ignore",
                    sessionId: "session-a",
                    signal: new AbortController().signal,
                })).rejects.toThrow("需要 Git 忽略 .pillar/worktrees/");
                await writeFile(join(cwd, ".gitignore"), ".pillar/worktrees/\n");
                await git(cwd, "add", ".gitignore");
                await git(cwd, "commit", "-q", "-m", "ignore worktrees");
                const outside = await mkdtemp(join(tmpdir(), "pillar-worktree-outside-"));
                await symlink(outside, join(cwd, ".pillar"));
                await expect(runtime(cwd, storage).create({
                    taskId: "task-symlink",
                    sessionId: "session-a",
                    signal: new AbortController().signal,
                })).rejects.toThrow("不能是 symlink");
                await rm(outside, {recursive: true, force: true});
            } finally {
                await rm(storage, {recursive: true, force: true});
            }
        });
    });

    test("非 Git 项目和已取消 signal 不会创建 Worktree", async () => {
        await withTempProject(async (cwd) => {
            const storage = await mkdtemp(join(tmpdir(), "pillar-worktree-unit-"));
            try {
                await expect(runtime(cwd, storage).create({
                    taskId: "task-no-git",
                    sessionId: "session-a",
                    signal: new AbortController().signal,
                })).rejects.toThrow("不是 Git repository");
                await initializeRepository(cwd);
                const controller = new AbortController();
                controller.abort("test");
                await expect(runtime(cwd, storage).create({
                    taskId: "task-cancelled",
                    sessionId: "session-a",
                    signal: controller.signal,
                })).rejects.toThrow("Git 操作已取消");
            } finally {
                await rm(storage, {recursive: true, force: true});
            }
        });
    });

    test("从 linked Worktree 启动时实体仍放在 canonical main Worktree", async () => {
        await withTempProject(async (root) => {
            const main = join(root, "main");
            const linked = join(root, "linked");
            const storage = join(root, "storage");
            await mkdir(main);
            await initializeRepository(main);
            await git(main, "worktree", "add", "-q", "-b", "linked-source", linked);
            const worktrees = runtime(linked, storage);
            const record = await worktrees.create({
                taskId: "task-linked",
                sessionId: "session-a",
                signal: new AbortController().signal,
            });
            expect(record.sourceGitRoot).toBe(await realpath(linked));
            expect(record.mainGitRoot).toBe(await realpath(main));
            expect(record.path).toStartWith(join(await realpath(main), ".pillar", "worktrees"));
            await worktrees.finish(record);
            await git(main, "worktree", "remove", "--force", linked);
            await git(main, "branch", "-D", "linked-source");
        });
    });

    test("同名临时分支已存在时拒绝创建且不删除原分支", async () => {
        await withTempProject(async (cwd) => {
            const storage = await mkdtemp(join(tmpdir(), "pillar-worktree-unit-"));
            try {
                await initializeRepository(cwd);
                await git(cwd, "branch", "pillar-agent-task-branch");
                await expect(runtime(cwd, storage).create({
                    taskId: "task-branch",
                    sessionId: "session-a",
                    signal: new AbortController().signal,
                })).rejects.toThrow("临时分支已存在");
                expect(await git(
                    cwd,
                    "show-ref",
                    "--verify",
                    "refs/heads/pillar-agent-task-branch"
                )).toContain("refs/heads/pillar-agent-task-branch");
            } finally {
                await rm(storage, {recursive: true, force: true});
            }
        });
    });
});
