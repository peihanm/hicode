import {createHash} from "node:crypto";
import {lstat, realpath} from "node:fs/promises";
import {isAbsolute, relative, resolve} from "node:path";
import {formatGitProcessError, type GitCommandRunner} from "../git/process.js";
import {parseGitStatusPorcelainV2} from "../git/status.js";
import type {GitFileStatus} from "../git/types.js";
import {isPathInside} from "./pathGuard.js";
import {
    assertRecordedWorktreePath,
    assertWorktreeParentSafety,
    worktreesRoot,
} from "./paths.js";
import type {
    AgentWorktreeRecord,
    AvailableWorktreeInspection,
    WorktreeChangedFile,
    WorktreeDiff,
    WorktreeInspection,
} from "./types.js";

const MAX_WORKTREE_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_CHANGED_FILES = 500;

interface RegisteredWorktree {
    path: string;
    head?: string;
    branch?: string;
}

function singleLine(output: Buffer): string {
    return output.toString("utf8").trim();
}

function parseWorktreeList(output: Buffer | string): RegisteredWorktree[] {
    const value = Buffer.isBuffer(output) ? output.toString("utf8") : output;
    return value.split("\0\0").flatMap((entry) => {
        if (!entry) return [];
        const fields = entry.split("\0");
        const path = fields.find((field) => field.startsWith("worktree "))
            ?.slice("worktree ".length);
        if (!path) throw new Error("Git worktree list 缺少 worktree 路径");
        const head = fields.find((field) => field.startsWith("HEAD "))
            ?.slice("HEAD ".length);
        const branch = fields.find((field) => field.startsWith("branch "))
            ?.slice("branch ".length);
        return [{path, ...(head ? {head} : {}), ...(branch ? {branch} : {})}];
    });
}

async function listRegisteredWorktrees(
    runGit: GitCommandRunner,
    cwd: string
): Promise<RegisteredWorktree[]> {
    const result = await runGit(cwd, [
        "--no-optional-locks",
        "worktree",
        "list",
        "--porcelain",
        "-z",
    ]);
    if (result.code !== 0) {
        throw new Error(`无法读取 Git Worktree 列表：${formatGitProcessError(result)}`);
    }
    return parseWorktreeList(result.stdout);
}

export async function resolveMainWorktreeRoot(
    runGit: GitCommandRunner,
    sourceGitRoot: string
): Promise<string> {
    const entries = await listRegisteredWorktrees(runGit, sourceGitRoot);
    const main = entries[0];
    if (!main) throw new Error("Git 没有返回主 Worktree");
    return realpath(main.path);
}

export async function assertWorktreesIgnored(
    runGit: GitCommandRunner,
    mainGitRoot: string
): Promise<void> {
    const result = await runGit(mainGitRoot, [
        "check-ignore",
        "-q",
        "--",
        ".pillar/worktrees/.pillar-ignore-probe",
    ]);
    if (result.code === 0) return;
    if (result.code === 1) {
        throw new Error(
            "创建 Worktree 前需要 Git 忽略 .pillar/worktrees/；请将该规则加入 .gitignore"
        );
    }
    throw new Error(`无法验证 .pillar/worktrees/ ignore 规则：${formatGitProcessError(result)}`);
}

function changedFile(file: GitFileStatus): WorktreeChangedFile {
    switch (file.kind) {
        case "added":
        case "untracked":
            return {path: file.path, kind: "create"};
        case "deleted":
            return {path: file.path, kind: "delete"};
        case "renamed":
            return {path: file.path, originalPath: file.originalPath, kind: "rename"};
        case "copied":
            return {path: file.path, originalPath: file.originalPath, kind: "copy"};
        case "conflicted":
            return {path: file.path, kind: "conflict"};
        case "type-changed":
            return {path: file.path, kind: "type-change"};
        case "modified":
            return {path: file.path, kind: "update"};
    }
}

function parseNameStatus(output: Buffer): WorktreeChangedFile[] {
    const fields = output.toString("utf8").split("\0");
    const files: WorktreeChangedFile[] = [];
    for (let index = 0; index < fields.length;) {
        const status = fields[index++];
        if (!status) continue;
        const firstPath = fields[index++];
        if (!firstPath) throw new Error(`Git diff ${status} 记录缺少路径`);
        if (status.startsWith("R") || status.startsWith("C")) {
            const path = fields[index++];
            if (!path) throw new Error(`Git diff ${status} 记录缺少目标路径`);
            files.push({
                path,
                originalPath: firstPath,
                kind: status.startsWith("R") ? "rename" : "copy",
            });
            continue;
        }
        const code = status[0];
        const kind = code === "A" ? "create" :
            code === "D" ? "delete" :
                code === "T" ? "type-change" : "update";
        files.push({path: firstPath, kind});
    }
    return files;
}

function mergeChangedFiles(
    tracked: readonly WorktreeChangedFile[],
    status: readonly GitFileStatus[]
): WorktreeChangedFile[] {
    const files = new Map<string, WorktreeChangedFile>();
    for (const file of tracked) files.set(`${file.originalPath ?? ""}\0${file.path}`, file);
    for (const file of status) {
        const item = changedFile(file);
        const key = `${item.originalPath ?? ""}\0${item.path}`;
        if (file.kind === "untracked" || file.kind === "conflicted" || !files.has(key)) {
            files.set(key, item);
        }
    }
    return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function unavailable(issue: string, registered: boolean): WorktreeInspection {
    return {
        status: "unavailable",
        registered,
        hasWork: true,
        changedFiles: [],
        issue,
    };
}

async function findRegisteredWorktree(
    runGit: GitCommandRunner,
    record: AgentWorktreeRecord
): Promise<RegisteredWorktree | undefined> {
    assertRecordedWorktreePath(record);
    await assertWorktreeParentSafety(record.mainGitRoot);
    const target = await lstat(record.path).catch(() => undefined);
    if (!target || !target.isDirectory() || target.isSymbolicLink()) return undefined;
    const entries = await listRegisteredWorktrees(runGit, record.sourceGitRoot);
    const expected = await realpath(record.path).catch(() => undefined);
    if (!expected) return undefined;
    const canonicalRoot = await realpath(worktreesRoot(record.mainGitRoot));
    if (!isPathInside(canonicalRoot, expected)) return undefined;
    for (const entry of entries) {
        const candidate = await realpath(entry.path).catch(() => undefined);
        if (candidate === expected) return entry;
    }
    return undefined;
}

export async function inspectWorktree(
    runGit: GitCommandRunner,
    record: AgentWorktreeRecord
): Promise<WorktreeInspection> {
    let registered: RegisteredWorktree | undefined;
    try {
        registered = await findRegisteredWorktree(runGit, record);
    } catch (error) {
        return unavailable(
            `无法核对 Git Worktree 注册状态：${error instanceof Error ? error.message : String(error)}`,
            false
        );
    }
    if (!registered) return unavailable("Worktree 不在当前 Git repository 的注册列表中", false);
    if (registered.branch !== `refs/heads/${record.branch}`) {
        return unavailable("Worktree 当前分支与 Manifest 不匹配", true);
    }
    const [status, head, ahead, names] = await Promise.all([
        runGit(record.path, [
            "--no-optional-locks", "status", "--porcelain=v2", "-z",
            "--find-renames=50%", "--untracked-files=all",
        ]),
        runGit(record.path, ["rev-parse", "HEAD"]),
        runGit(record.path, ["rev-list", "--count", `${record.baseCommit}..HEAD`]),
        runGit(record.path, [
            "diff", "--name-status", "-z", "--find-renames=50%",
            record.baseCommit, "--", ".",
        ]),
    ]);
    const failed = [status, head, ahead, names].find((result) => result.code !== 0);
    if (failed) {
        return unavailable(`Worktree 状态检查失败：${formatGitProcessError(failed)}`, true);
    }
    try {
        const parsedStatus = parseGitStatusPorcelainV2(status.stdout);
        const commitsAhead = Number(singleLine(ahead.stdout));
        if (!Number.isSafeInteger(commitsAhead) || commitsAhead < 0) {
            throw new Error("Git 返回了无效的 commitsAhead");
        }
        const detectedFiles = mergeChangedFiles(
            parseNameStatus(names.stdout),
            parsedStatus.files
        );
        const changedFiles = detectedFiles.slice(0, MAX_CHANGED_FILES);
        const headCommit = singleLine(head.stdout);
        if (!/^[0-9a-f]{40,64}$/i.test(headCommit)) {
            throw new Error("Git 返回了无效的 HEAD commit");
        }
        const revision = createHash("sha256")
            .update(head.stdout)
            .update(status.stdout)
            .update(names.stdout)
            .digest("hex");
        const dirty = parsedStatus.files.length > 0;
        return {
            status: "available",
            registered: true,
            headCommit,
            dirty,
            commitsAhead,
            hasWork: dirty || commitsAhead > 0,
            revision,
            changedFiles,
            omittedChangedFiles: detectedFiles.length - changedFiles.length,
            untrackedFiles: parsedStatus.files
                .filter((file) => file.kind === "untracked")
                .map((file) => file.path),
        };
    } catch (error) {
        return unavailable(
            `无法解析 Worktree 状态：${error instanceof Error ? error.message : String(error)}`,
            true
        );
    }
}

function safeRelativePath(path: string): boolean {
    if (!path || path.includes("\0") || isAbsolute(path)) return false;
    return relative("/", resolve("/", path)) === path;
}

export async function readWorktreeDiff(
    runGit: GitCommandRunner,
    record: AgentWorktreeRecord,
    inspection: AvailableWorktreeInspection
): Promise<WorktreeDiff> {
    const tracked = await runGit(record.path, [
        "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary",
        record.baseCommit, "--", ".",
    ], undefined, {maxOutputBytes: MAX_WORKTREE_DIFF_BYTES});
    if (tracked.code !== 0) {
        throw new Error(`无法生成 Worktree diff：${formatGitProcessError(tracked)}`);
    }
    const statResult = await runGit(record.path, [
        "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--stat",
        record.baseCommit, "--", ".",
    ]);
    if (statResult.code !== 0) {
        throw new Error(`无法生成 Worktree diff stat：${formatGitProcessError(statResult)}`);
    }
    const patches = [tracked.stdout];
    let bytes = tracked.stdout.length;
    const untrackedStats: string[] = [];
    for (const relativePath of inspection.untrackedFiles) {
        if (!safeRelativePath(relativePath)) continue;
        const path = resolve(record.path, relativePath);
        if (!isPathInside(record.path, path)) throw new Error(`Worktree diff 路径越界: ${relativePath}`);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        untrackedStats.push(` ${relativePath} | ${info.size} bytes (new)`);
        const diff = await runGit(record.path, [
            "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color",
            "--binary", "--", "/dev/null", path,
        ], undefined, {maxOutputBytes: MAX_WORKTREE_DIFF_BYTES - bytes});
        if (diff.code !== 0 && diff.code !== 1) {
            throw new Error(`无法生成未跟踪文件 diff (${relativePath})：${formatGitProcessError(diff)}`);
        }
        bytes += diff.stdout.length;
        if (bytes > MAX_WORKTREE_DIFF_BYTES) {
            throw new Error(`Worktree diff 超过 ${MAX_WORKTREE_DIFF_BYTES} 字节上限`);
        }
        patches.push(diff.stdout);
    }
    return {
        stat: [statResult.stdout.toString("utf8").trimEnd(), ...untrackedStats]
            .filter(Boolean).join("\n") ||
            `${inspection.changedFiles.length + inspection.omittedChangedFiles} changed file(s)`,
        patch: Buffer.concat(patches).toString("utf8"),
    };
}

export async function isRegisteredWorktree(
    runGit: GitCommandRunner,
    record: AgentWorktreeRecord
): Promise<boolean> {
    return Boolean(await findRegisteredWorktree(runGit, record));
}
