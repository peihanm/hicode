import {lstat, mkdir, realpath} from "node:fs/promises";
import {join, relative, resolve} from "node:path";
import {hasFileSystemErrorCode} from "../persistence/index.js";
import {isPathInside} from "./pathGuard.js";

const WORKTREE_DIRECTORY = join(".pillar", "worktrees");

export function safeWorktreeTaskId(taskId: string): string {
    const safe = taskId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12);
    if (!safe) throw new Error("Task ID 无法生成安全 Worktree 名称");
    return safe;
}

export function worktreesRoot(mainGitRoot: string): string {
    return resolve(mainGitRoot, WORKTREE_DIRECTORY);
}

export function worktreePath(mainGitRoot: string, taskId: string): string {
    return resolve(worktreesRoot(mainGitRoot), `agent-${safeWorktreeTaskId(taskId)}`);
}

export function worktreeBranch(taskId: string): string {
    return `pillar-agent-${safeWorktreeTaskId(taskId)}`;
}

async function assertSafeExistingDirectory(path: string, label: string): Promise<void> {
    try {
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
            throw new Error(`${label} 不能是 symlink: ${path}`);
        }
        if (!info.isDirectory()) {
            throw new Error(`${label} 不是目录: ${path}`);
        }
    } catch (error) {
        if (hasFileSystemErrorCode(error, "ENOENT")) return;
        throw error;
    }
}

export async function assertWorktreeParentSafety(mainGitRoot: string): Promise<void> {
    await assertSafeExistingDirectory(resolve(mainGitRoot, ".pillar"), ".pillar");
    await assertSafeExistingDirectory(worktreesRoot(mainGitRoot), ".pillar/worktrees");
}

export async function prepareWorktreeDirectory(
    mainGitRoot: string,
    taskId: string
): Promise<{root: string; path: string}> {
    const root = worktreesRoot(mainGitRoot);
    const path = worktreePath(mainGitRoot, taskId);
    if (!isPathInside(root, path)) throw new Error("Worktree 路径越界");

    const pillarDirectory = resolve(mainGitRoot, ".pillar");
    await assertWorktreeParentSafety(mainGitRoot);
    try {
        await lstat(path);
        throw new Error(`Worktree 目标路径已存在: ${path}`);
    } catch (error) {
        if (!hasFileSystemErrorCode(error, "ENOENT")) throw error;
    }

    await mkdir(root, {recursive: true, mode: 0o700});
    await assertSafeExistingDirectory(pillarDirectory, ".pillar");
    await assertSafeExistingDirectory(root, ".pillar/worktrees");

    const [canonicalMainRoot, canonicalRoot] = await Promise.all([
        realpath(mainGitRoot),
        realpath(root),
    ]);
    if (!isPathInside(canonicalMainRoot, canonicalRoot)) {
        throw new Error("Worktree Root 经过 symlink 解析到 repository 之外");
    }
    return {root: canonicalRoot, path};
}

export function assertRecordedWorktreePath(input: {
    mainGitRoot: string;
    taskId: string;
    path: string;
    branch: string;
}): void {
    const expectedPath = worktreePath(input.mainGitRoot, input.taskId);
    const expectedBranch = worktreeBranch(input.taskId);
    if (resolve(input.path) !== expectedPath || input.branch !== expectedBranch) {
        throw new Error("Worktree manifest 路径或分支与 Task 不匹配");
    }
}

export async function mapSourceCwdToWorktree(input: {
    sourceCwd: string;
    sourceGitRoot: string;
    worktreePath: string;
}): Promise<{cwd: string; root: string}> {
    const [sourceRoot, sourceCwd, targetRoot] = await Promise.all([
        realpath(input.sourceGitRoot),
        realpath(input.sourceCwd),
        realpath(input.worktreePath),
    ]);
    if (!isPathInside(sourceRoot, sourceCwd)) {
        throw new Error("当前 cwd 不属于来源 Git checkout");
    }
    const mapped = resolve(targetRoot, relative(sourceRoot, sourceCwd));
    let targetCwd: string;
    try {
        targetCwd = await realpath(mapped);
    } catch (error) {
        if (hasFileSystemErrorCode(error, "ENOENT")) {
            throw new Error(
                "当前 cwd 在 base commit 中不存在；Worktree 不包含主工作区未提交目录"
            );
        }
        throw error;
    }
    if (!isPathInside(targetRoot, targetCwd)) {
        throw new Error("Worktree cwd 解析到隔离目录之外");
    }
    return {cwd: targetCwd, root: targetRoot};
}
