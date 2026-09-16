import {describe, expect, test} from "bun:test";
import {mkdir, rm, symlink, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createGitCommandRunner} from "../../src/git/process.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {
    parseGitNumstatZ,
    parseGitStatusPorcelainV2,
    readGitRepositorySnapshot,
} from "../../src/git/status.js";
import type {GitRepositorySnapshot} from "../../src/git/types.js";
import {createGitWorkspaceRuntime} from "../../src/git/runtime.js";
import {withTempProject} from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const runGitCommand = createGitCommandRunner(testChildEnvironment);

interface TestGitResult {
    code: number;
    stdout: string;
    stderr: string;
}

async function gitResult(cwd: string, ...args: string[]): Promise<TestGitResult> {
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
    return {code, stdout, stderr};
}

async function git(cwd: string, ...args: string[]): Promise<string> {
    const result = await gitResult(cwd, ...args);
    if (result.code !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout.trim();
}

async function initializeRepository(cwd: string): Promise<string> {
    await git(cwd, "init", "-q");
    await git(cwd, "config", "user.name", "HiCode Test");
    await git(cwd, "config", "user.email", "hicode-test@example.com");
    return git(cwd, "branch", "--show-current");
}

async function snapshot(cwd: string): Promise<GitRepositorySnapshot> {
    const result = await readGitRepositorySnapshot(runGitCommand, cwd);
    if (result.status === "unavailable") throw new Error(result.message);
    return result.snapshot;
}

async function commitFile(
    cwd: string,
    path: string,
    content: string,
    message: string
): Promise<void> {
    await writeFile(join(cwd, path), content);
    await git(cwd, "add", "--", path);
    await git(cwd, "commit", "-q", "-m", message);
}

describe("Git repository snapshot", () => {
    test("非 Git 目录返回 unavailable，空仓库准确标记 unborn", async () => {
        await withTempProject(async (cwd) => {
            const missing = await readGitRepositorySnapshot(runGitCommand, cwd);
            expect(missing).toMatchObject({
                status: "unavailable",
                reason: "not-git-repository",
            });

            const branch = await initializeRepository(cwd);
            const initial = await snapshot(cwd);
            expect(initial).toMatchObject({
                branch,
                headOid: null,
                detached: false,
                unborn: true,
                operation: "normal",
                clean: true,
                files: [],
            });
        });
    });

    test("解析 staged、unstaged、untracked、rename、delete 和特殊文件名", async () => {
        await withTempProject(async (cwd) => {
            const branch = await initializeRepository(cwd);
            await writeFile(join(cwd, "rename-old.txt"), "rename\n");
            await writeFile(join(cwd, "delete.txt"), "delete\n");
            await writeFile(join(cwd, "mixed.txt"), "base\n");
            await git(cwd, "add", "--", "rename-old.txt", "delete.txt", "mixed.txt");
            await git(cwd, "commit", "-q", "-m", "initial");

            await git(cwd, "mv", "--", "rename-old.txt", "rename new.txt");
            await rm(join(cwd, "delete.txt"));
            await writeFile(join(cwd, "mixed.txt"), "staged\n");
            await git(cwd, "add", "--", "mixed.txt");
            await writeFile(join(cwd, "mixed.txt"), "unstaged\n");
            const specialPath = "line\nbreak.txt";
            await writeFile(join(cwd, specialPath), "untracked\n");

            const current = await snapshot(cwd);
            expect(current.branch).toBe(branch);
            expect(current.headOid).toMatch(/^[0-9a-f]{40,64}$/);
            expect(current.clean).toBe(false);
            expect(current.files.find((file) => file.path === "rename new.txt"))
                .toMatchObject({
                    originalPath: "rename-old.txt",
                    kind: "renamed",
                    indexStatus: "R",
                    worktreeStatus: null,
                    staged: true,
                    unstaged: false,
                });
            expect(current.files.find((file) => file.path === "delete.txt"))
                .toMatchObject({
                    kind: "deleted",
                    indexStatus: null,
                    worktreeStatus: "D",
                });
            expect(current.files.find((file) => file.path === "mixed.txt"))
                .toMatchObject({
                    kind: "modified",
                    indexStatus: "M",
                    worktreeStatus: "M",
                    staged: true,
                    unstaged: true,
                });
            expect(current.files.find((file) => file.path === specialPath))
                .toMatchObject({
                    kind: "untracked",
                    staged: false,
                    unstaged: true,
                });

            await git(cwd, "checkout", "--detach", "-q");
            const detached = await snapshot(cwd);
            expect(detached).toMatchObject({
                branch: null,
                detached: true,
                unborn: false,
            });
        });
    });

    test("merge 冲突同时暴露 operation 与 conflicted 文件", async () => {
        await withTempProject(async (cwd) => {
            const main = await initializeRepository(cwd);
            await commitFile(cwd, "conflict.txt", "base\n", "initial");
            await git(cwd, "checkout", "-q", "-b", "feature");
            await commitFile(cwd, "conflict.txt", "feature\n", "feature");
            await git(cwd, "checkout", "-q", main);
            await commitFile(cwd, "conflict.txt", "main\n", "main");

            const merged = await gitResult(cwd, "merge", "feature");
            expect(merged.code).not.toBe(0);
            const current = await snapshot(cwd);
            expect(current.operation).toBe("merge");
            expect(current.files.find((file) => file.path === "conflict.txt"))
                .toMatchObject({kind: "conflicted"});
        });
    });

    test("识别 rebase、cherry-pick 与 revert 中间状态", async () => {
        const scenarios: Array<{
            expected: "rebase" | "cherry-pick" | "revert";
            start: (cwd: string, main: string) => Promise<TestGitResult>;
        }> = [
            {
                expected: "rebase",
                async start(cwd, main) {
                    await git(cwd, "checkout", "-q", "-b", "feature");
                    await commitFile(cwd, "conflict.txt", "feature\n", "feature");
                    await git(cwd, "checkout", "-q", main);
                    await commitFile(cwd, "conflict.txt", "main\n", "main");
                    await git(cwd, "checkout", "-q", "feature");
                    return gitResult(cwd, "rebase", main);
                },
            },
            {
                expected: "cherry-pick",
                async start(cwd, main) {
                    await git(cwd, "checkout", "-q", "-b", "feature");
                    await commitFile(cwd, "conflict.txt", "feature\n", "feature");
                    const commit = await git(cwd, "rev-parse", "HEAD");
                    await git(cwd, "checkout", "-q", main);
                    await commitFile(cwd, "conflict.txt", "main\n", "main");
                    return gitResult(cwd, "cherry-pick", commit);
                },
            },
            {
                expected: "revert",
                async start(cwd) {
                    await commitFile(cwd, "conflict.txt", "target\n", "target");
                    const target = await git(cwd, "rev-parse", "HEAD");
                    await commitFile(cwd, "conflict.txt", "later\n", "later");
                    return gitResult(cwd, "revert", "--no-edit", target);
                },
            },
        ];

        for (const scenario of scenarios) {
            await withTempProject(async (cwd) => {
                const main = await initializeRepository(cwd);
                await commitFile(cwd, "conflict.txt", "base\n", "initial");
                const started = await scenario.start(cwd, main);
                expect(started.code).not.toBe(0);
                expect((await snapshot(cwd)).operation).toBe(scenario.expected);
            });
        }
    });

    test("真实 Submodule 修改保留 Git 的四字符状态", async () => {
        await withTempProject(async (cwd) => {
            const source = join(cwd, "submodule-source");
            const parent = join(cwd, "parent");
            await mkdir(source);
            await mkdir(parent);
            await initializeRepository(source);
            await commitFile(source, "sub.txt", "base\n", "initial");
            await initializeRepository(parent);
            await git(
                parent,
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                source,
                "vendor/local"
            );
            await git(parent, "commit", "-q", "-m", "add submodule");
            await writeFile(join(parent, "vendor/local/sub.txt"), "changed\n");

            const current = await snapshot(parent);
            expect(current.files.find((file) => file.path === "vendor/local"))
                .toMatchObject({
                    kind: "modified",
                    indexStatus: null,
                    worktreeStatus: "M",
                    submodule: "S.M.",
                });
        });
    });

    test("主工作区与 Git Worktree 共享 Repository identity", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            await commitFile(cwd, "base.txt", "base\n", "initial");
            const worktree = join(cwd, ".hicode-test-worktree");
            await git(cwd, "worktree", "add", "-q", "-b", "worktree-test", worktree);

            const source = await snapshot(cwd);
            const isolated = await snapshot(worktree);
            expect(isolated.repositoryRoot).not.toBe(source.repositoryRoot);
        });
    });
});

describe("Git NUL parser", () => {
    test("解析 copy record、binary numstat 和包含 Tab/换行的路径", () => {
        const hash = "0".repeat(40);
        const status = parseGitStatusPorcelainV2(
            `2 C. N... 100644 100644 100644 ${hash} ${hash} C100 copy new.txt\0copy old.txt\0` +
            "? tab\tname\n.txt\0"
        );
        expect(status.files).toEqual([
            {
                path: "copy new.txt",
                originalPath: "copy old.txt",
                kind: "copied",
                indexStatus: "C",
                worktreeStatus: null,
                staged: true,
                unstaged: false,
                submodule: "N...",
            },
            {
                path: "tab\tname\n.txt",
                kind: "untracked",
                indexStatus: null,
                worktreeStatus: null,
                staged: false,
                unstaged: true,
                submodule: null,
            },
        ]);

        expect(parseGitNumstatZ(
            "3\t1\tregular name.txt\0" +
            "-\t-\timage.bin\0" +
            "4\t2\t\0old\nname.txt\0new\tname.txt\0"
        )).toEqual([
            {
                path: "image.bin",
                additions: null,
                deletions: null,
                binary: true,
            },
            {
                path: "new\tname.txt",
                originalPath: "old\nname.txt",
                additions: 4,
                deletions: 2,
                binary: false,
            },
            {
                path: "regular name.txt",
                additions: 3,
                deletions: 1,
                binary: false,
            },
        ]);
    });
});

describe("Git process", () => {
    test("Git 与其外部 helper 不继承 Provider Secret", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            const runRestrictedGit = createGitCommandRunner(
                createChildProcessEnvironment({
                    ...process.env,
                    JENIYA_AUTH: "sensitive",
                    HICODE_VISIBLE_TEST_VALUE: "visible",
                }, ["JENIYA_AUTH"])
            );
            const result = await runRestrictedGit(cwd, [
                "-c",
                "alias.hicode-env=!printf '%s:%s' \"${JENIYA_AUTH-unset}\" \"${HICODE_VISIBLE_TEST_VALUE-unset}\"",
                "hicode-env",
            ]);

            expect(result.code).toBe(0);
            expect(result.stdout.toString("utf8")).toBe("unset:visible");
        });
    });

    test("AbortSignal 会终止真实 Git 子进程", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            const controller = new AbortController();
            const pending = runGitCommand(cwd, [
                "-c",
                "alias.hicode-wait=!sleep 10",
                "hicode-wait",
            ], controller.signal);
            setTimeout(() => controller.abort("test"), 25);
            const result = await pending;
            expect(result).toMatchObject({
                code: 130,
                termination: {kind: "aborted"},
            });
        });
    });
});

describe("Git diff snapshot", () => {
    test("当前修改包含 staged、unstaged 的最终状态和 untracked 文件", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            await commitFile(cwd, "mixed.txt", "base\n", "initial");
            await writeFile(join(cwd, "mixed.txt"), "staged\n");
            await git(cwd, "add", "--", "mixed.txt");
            await writeFile(join(cwd, "mixed.txt"), "working\n");
            await writeFile(join(cwd, "new file.txt"), "new\n");

            const runtime = createGitWorkspaceRuntime(cwd, testChildEnvironment);
            const signal = new AbortController().signal;
            const current = await runtime.diff(signal);

            expect(current.status).toBe("available");
            if (current.status === "available") {
                expect(current.snapshot.files.map((file) => file.status.path))
                    .toEqual(["mixed.txt", "new file.txt"]);
                expect(current.snapshot.patch).toContain("+working");
                expect(current.snapshot.patch).toContain("+new");
                expect(current.snapshot.patch).not.toContain("+staged");
            }
        });
    });

    test("二进制 untracked 文件保留元数据但不伪造文本 hunk", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            await writeFile(join(cwd, "image.bin"), new Uint8Array([0, 1, 2, 3]));
            const result = await createGitWorkspaceRuntime(cwd, testChildEnvironment).diff(
                new AbortController().signal
            );
            expect(result.status).toBe("available");
            if (result.status === "available") {
                expect(result.snapshot.files[0]).toMatchObject({
                    status: {path: "image.bin"},
                    binary: true,
                    diffStatus: "unavailable",
                    unavailableReason: "binary",
                    hunks: [],
                });
            }
        });
    });

    test("tracked 特殊文件名、rename 和 delete 都能关联到正确 Patch", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            const specialPath = "line\nbreak.txt";
            await writeFile(join(cwd, specialPath), "old\n");
            await writeFile(join(cwd, "rename-old.txt"), "rename\n");
            await writeFile(join(cwd, "delete.txt"), "delete\n");
            await git(
                cwd,
                "add",
                "--",
                specialPath,
                "rename-old.txt",
                "delete.txt"
            );
            await git(cwd, "commit", "-q", "-m", "initial");
            await writeFile(join(cwd, specialPath), "new\n");
            await git(cwd, "mv", "--", "rename-old.txt", "rename new.txt");
            await rm(join(cwd, "delete.txt"));

            const result = await createGitWorkspaceRuntime(cwd, testChildEnvironment).diff(
                new AbortController().signal
            );
            expect(result.status).toBe("available");
            if (result.status === "available") {
                expect(result.snapshot.files.map((file) => file.status.path))
                    .toEqual(["delete.txt", specialPath, "rename new.txt"]);
                expect(result.snapshot.files.find(
                    (file) => file.status.path === specialPath
                )?.hunks.length).toBeGreaterThan(0);
                expect(result.snapshot.files.find(
                    (file) => file.status.path === "delete.txt"
                )?.hunks.length).toBeGreaterThan(0);
                expect(result.snapshot.files.find(
                    (file) => file.status.path === "rename new.txt"
                )).toMatchObject({
                    additions: 0,
                    deletions: 0,
                    diffStatus: "complete",
                    hunks: [],
                });
            }
        });
    });

    test("untracked symlink 不会让 Diff 读取仓库外目标", async () => {
        await withTempProject(async (cwd) => {
            await initializeRepository(cwd);
            await symlink("/etc/passwd", join(cwd, "outside-link"));
            const result = await createGitWorkspaceRuntime(cwd, testChildEnvironment).diff(
                new AbortController().signal
            );
            expect(result.status).toBe("available");
            if (result.status === "available") {
                expect(result.snapshot.patch).not.toContain("root:");
                expect(result.snapshot.files[0]).toMatchObject({
                    status: {path: "outside-link"},
                    diffStatus: "unavailable",
                    unavailableReason: "symlink",
                    hunks: [],
                });
            }
        });
    });
});
