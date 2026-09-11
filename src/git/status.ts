import {access, realpath} from "node:fs/promises";
import {join} from "node:path";
import {
    formatGitProcessError,
    type GitCommandRunner,
    type GitProcessTermination,
} from "./process.js";
import type {
    GitFileChangeKind,
    GitFileStatus,
    GitNumstatEntry,
    GitOperationState,
    GitRepositoryRootResult,
    GitRepositorySnapshotResult,
    GitRepositoryUnavailableReason,
    GitStatusCode,
    ParsedGitStatus,
} from "./types.js";
import {compareGitText} from "./sort.js";

interface FixedFields {
    fields: string[];
    remainder: string;
}

const cancelledRepositoryResult = {
    status: "unavailable",
    reason: "cancelled",
    message: "Git 操作已取消",
} as const;

function takeFixedFields(value: string, count: number): FixedFields | undefined {
    const fields: string[] = [];
    let cursor = 0;
    for (let index = 0; index < count; index++) {
        const separator = value.indexOf(" ", cursor);
        if (separator < 0) return undefined;
        fields.push(value.slice(cursor, separator));
        cursor = separator + 1;
    }
    return {fields, remainder: value.slice(cursor)};
}

function statusCode(value: string): GitStatusCode | null {
    if (value === ".") return null;
    if (
        value === "M" || value === "T" || value === "A" ||
        value === "D" || value === "R" || value === "C" || value === "U"
    ) return value;
    throw new Error(`未知 Git status code: ${value}`);
}

function changeKind(
    indexStatus: GitStatusCode | null,
    worktreeStatus: GitStatusCode | null,
    forced?: "renamed" | "copied" | "conflicted"
): GitFileChangeKind {
    if (forced) return forced;
    const codes = [indexStatus, worktreeStatus];
    if (codes.includes("U")) return "conflicted";
    if (codes.includes("D")) return "deleted";
    if (codes.includes("A")) return "added";
    if (codes.includes("T")) return "type-changed";
    return "modified";
}

function fileStatus(input: {
    path: string;
    originalPath?: string;
    xy: string;
    submodule: string;
    forcedKind?: "renamed" | "copied" | "conflicted";
}): GitFileStatus {
    if (input.xy.length !== 2) {
        throw new Error(`无效 Git XY status: ${input.xy}`);
    }
    const indexStatus = statusCode(input.xy[0]!);
    const worktreeStatus = statusCode(input.xy[1]!);
    return {
        path: input.path,
        ...(input.originalPath === undefined
            ? {}
            : {originalPath: input.originalPath}),
        kind: changeKind(indexStatus, worktreeStatus, input.forcedKind),
        indexStatus,
        worktreeStatus,
        staged: indexStatus !== null,
        unstaged: worktreeStatus !== null,
        submodule: input.submodule,
    };
}

function parseHeader(record: string, parsed: {
    branch: string | null;
    headOid: string | null;
    detached: boolean;
    unborn: boolean;
}): void {
    if (record.startsWith("# branch.oid ")) {
        const value = record.slice("# branch.oid ".length);
        parsed.unborn = value === "(initial)";
        parsed.headOid = parsed.unborn ? null : value;
        return;
    }
    if (record.startsWith("# branch.head ")) {
        const value = record.slice("# branch.head ".length);
        parsed.detached = value === "(detached)";
        parsed.branch = parsed.detached ? null : value;
        return;
    }
}

export function parseGitStatusPorcelainV2(
    output: Buffer | string
): ParsedGitStatus {
    const records = (Buffer.isBuffer(output) ? output.toString("utf8") : output)
        .split("\0");
    const parsed = {
        branch: null as string | null,
        headOid: null as string | null,
        detached: false,
        unborn: false,
    };
    const files: GitFileStatus[] = [];

    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record) continue;
        if (record.startsWith("# ")) {
            parseHeader(record, parsed);
            continue;
        }
        if (record.startsWith("1 ")) {
            const fixed = takeFixedFields(record.slice(2), 7);
            if (!fixed) throw new Error(`无效 Git ordinary status: ${record}`);
            files.push(fileStatus({
                path: fixed.remainder,
                xy: fixed.fields[0]!,
                submodule: fixed.fields[1]!,
            }));
            continue;
        }
        if (record.startsWith("2 ")) {
            const fixed = takeFixedFields(record.slice(2), 8);
            const originalPath = records[index + 1];
            if (!fixed || originalPath === undefined || originalPath === "") {
                throw new Error(`无效 Git rename/copy status: ${record}`);
            }
            index += 1;
            const score = fixed.fields[7]!;
            const forcedKind = score.startsWith("R") ? "renamed" :
                score.startsWith("C") ? "copied" : undefined;
            if (!forcedKind) throw new Error(`未知 Git rename/copy score: ${score}`);
            files.push(fileStatus({
                path: fixed.remainder,
                originalPath,
                xy: fixed.fields[0]!,
                submodule: fixed.fields[1]!,
                forcedKind,
            }));
            continue;
        }
        if (record.startsWith("u ")) {
            const fixed = takeFixedFields(record.slice(2), 9);
            if (!fixed) throw new Error(`无效 Git unmerged status: ${record}`);
            files.push(fileStatus({
                path: fixed.remainder,
                xy: fixed.fields[0]!,
                submodule: fixed.fields[1]!,
                forcedKind: "conflicted",
            }));
            continue;
        }
        if (record.startsWith("? ")) {
            files.push({
                path: record.slice(2),
                kind: "untracked",
                indexStatus: null,
                worktreeStatus: null,
                staged: false,
                unstaged: true,
                submodule: null,
            });
            continue;
        }
        if (record.startsWith("! ")) continue;
        throw new Error(`未知 Git porcelain v2 record: ${record}`);
    }

    files.sort((left, right) => compareGitText(left.path, right.path) ||
        compareGitText(left.originalPath ?? "", right.originalPath ?? ""));
    return {...parsed, files};
}

function readSingleGitLine(output: Buffer): string {
    let value = output.toString("utf8");
    if (value.endsWith("\n")) value = value.slice(0, -1);
    if (value.endsWith("\r")) value = value.slice(0, -1);
    return value;
}

function parseNumstatCount(value: string): number | null {
    if (value === "-") return null;
    if (!/^\d+$/.test(value)) throw new Error(`无效 Git numstat 数值: ${value}`);
    const count = Number(value);
    if (!Number.isSafeInteger(count)) {
        throw new Error(`Git numstat 数值超过安全范围: ${value}`);
    }
    return count;
}

export function parseGitNumstatZ(output: Buffer | string): readonly GitNumstatEntry[] {
    const records = (Buffer.isBuffer(output) ? output.toString("utf8") : output)
        .split("\0");
    const entries: GitNumstatEntry[] = [];
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record) continue;
        const firstTab = record.indexOf("\t");
        const secondTab = record.indexOf("\t", firstTab + 1);
        if (firstTab < 0 || secondTab < 0) {
            throw new Error(`无效 Git numstat record: ${record}`);
        }
        const additions = parseNumstatCount(record.slice(0, firstTab));
        const deletions = parseNumstatCount(record.slice(firstTab + 1, secondTab));
        if ((additions === null) !== (deletions === null)) {
            throw new Error(`Git binary numstat 必须同时使用 '-'：${record}`);
        }
        const path = record.slice(secondTab + 1);
        let originalPath: string | undefined;
        let finalPath = path;
        if (path === "") {
            originalPath = records[index + 1];
            finalPath = records[index + 2] ?? "";
            if (!originalPath || !finalPath) {
                throw new Error(`无效 Git rename/copy numstat record: ${record}`);
            }
            index += 2;
        }
        entries.push({
            path: finalPath,
            ...(originalPath === undefined ? {} : {originalPath}),
            additions,
            deletions,
            binary: additions === null && deletions === null,
        });
    }
    entries.sort((left, right) => compareGitText(left.path, right.path) ||
        compareGitText(left.originalPath ?? "", right.originalPath ?? ""));
    return entries;
}

function unavailableReason(
    termination: GitProcessTermination,
    fallback: GitRepositoryUnavailableReason
): GitRepositoryUnavailableReason {
    if (termination.kind === "aborted") return "cancelled";
    if (termination.kind === "spawn-error") return "git-unavailable";
    return fallback;
}

async function resolveGitRepositoryRoot(
    runGit: GitCommandRunner,
    cwd: string,
    signal?: AbortSignal
): Promise<GitRepositoryRootResult> {
    const result = await runGit(cwd, [
        "--no-optional-locks",
        "rev-parse",
        "--show-toplevel",
    ], signal);
    if (result.code !== 0) {
        return {
            status: "unavailable",
            reason: unavailableReason(result.termination, "not-git-repository"),
            message: formatGitProcessError(result),
        };
    }
    if (signal?.aborted) return cancelledRepositoryResult;
    const reportedRoot = readSingleGitLine(result.stdout);
    if (!reportedRoot) {
        return {
            status: "unavailable",
            reason: "command-failed",
            message: "Git 未返回 repository root",
        };
    }
    try {
        const repositoryRoot = await realpath(reportedRoot);
        if (signal?.aborted) return cancelledRepositoryResult;
        return {
            status: "available",
            repositoryRoot,
        };
    } catch (error) {
        return {
            status: "unavailable",
            reason: "command-failed",
            message: `无法解析 Git repository root: ${
                error instanceof Error ? error.message : String(error)
            }`,
        };
    }
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch (error) {
        if (
            error && typeof error === "object" && "code" in error &&
            (error as {code?: string}).code === "ENOENT"
        ) return false;
        throw error;
    }
}

async function readOperationState(gitDirectory: string): Promise<GitOperationState> {
    if (
        await pathExists(join(gitDirectory, "rebase-merge")) ||
        await pathExists(join(gitDirectory, "rebase-apply"))
    ) return "rebase";
    if (await pathExists(join(gitDirectory, "MERGE_HEAD"))) return "merge";
    if (await pathExists(join(gitDirectory, "CHERRY_PICK_HEAD"))) return "cherry-pick";
    if (await pathExists(join(gitDirectory, "REVERT_HEAD"))) return "revert";
    return "normal";
}

export async function readGitRepositorySnapshot(
    runGit: GitCommandRunner,
    cwd: string,
    signal?: AbortSignal
): Promise<GitRepositorySnapshotResult> {
    const root = await resolveGitRepositoryRoot(runGit, cwd, signal);
    if (root.status === "unavailable") return root;

    const [statusResult, gitDirectoryResult] = await Promise.all([
        runGit(root.repositoryRoot, [
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--no-ahead-behind",
            "--find-renames=50%",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ], signal),
        runGit(root.repositoryRoot, [
            "--no-optional-locks",
            "rev-parse",
            "--absolute-git-dir",
        ], signal),
    ]);
    const failed = statusResult.code !== 0 ? statusResult :
        gitDirectoryResult.code !== 0 ? gitDirectoryResult : undefined;
    if (failed) {
        return {
            status: "unavailable",
            reason: unavailableReason(failed.termination, "command-failed"),
            message: formatGitProcessError(failed),
        };
    }
    if (signal?.aborted) return cancelledRepositoryResult;

    try {
        const parsed = parseGitStatusPorcelainV2(statusResult.stdout);
        const gitPaths = gitDirectoryResult.stdout.toString("utf8")
            .split(/\r?\n/)
            .filter(Boolean);
        const gitDirectory = gitPaths[0];
        if (!gitDirectory) throw new Error("Git 未返回 absolute git dir");
        const operation = await readOperationState(gitDirectory);
        if (signal?.aborted) return cancelledRepositoryResult;
        return {
            status: "available",
            snapshot: {
                version: 1,
                repositoryRoot: root.repositoryRoot,
                ...parsed,
                operation,
                clean: parsed.files.length === 0,
            },
        };
    } catch (error) {
        return {
            status: "unavailable",
            reason: "command-failed",
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
