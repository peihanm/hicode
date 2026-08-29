import {lstat} from "node:fs/promises";
import {resolve} from "node:path";
import {parsePatch} from "diff";
import {convertUnifiedDiffHunk} from "../fileChanges/index.js";
import {mapWithConcurrencyLimit} from "../tools/orchestration.js";
import {formatGitProcessError, runGitCommand} from "./process.js";
import {parseGitNumstatZ, readGitRepositorySnapshot,} from "./status.js";
import type {
    GitDiffFile,
    GitDiffSnapshotResult,
    GitFileStatus,
    GitNumstatEntry,
    GitRepositorySnapshotResult,
    GitRepositoryUnavailableReason,
} from "./types.js";
import {compareGitText} from "./sort.js";

const MAX_DIFF_FILES = 500;
const MAX_DIFF_HUNK_LINES = 10_000;

export interface GitWorkspaceRuntimeLike {
    status(signal: AbortSignal): Promise<GitRepositorySnapshotResult>;

    diff(signal: AbortSignal): Promise<GitDiffSnapshotResult>;
}

interface ParsedPatchFile {
    path: string;
    binary: boolean;
    hunks: GitDiffFile["hunks"];
}

function stripGitPrefix(path: string | undefined): string | undefined {
    if (!path || path === "/dev/null") return undefined;
    return path.startsWith("a/") || path.startsWith("b/")
        ? path.slice(2)
        : path;
}

function parsePatchFiles(patch: string): ParsedPatchFile[] {
    if (!patch.trim()) return [];
    return parsePatch(patch).flatMap((file) => {
        const path = stripGitPrefix(file.newFileName) ??
            stripGitPrefix(file.oldFileName);
        if (!path) return [];
        return [{
            path,
            binary: file.isBinary === true,
            hunks: file.hunks.map(convertUnifiedDiffHunk),
        }];
    });
}

function diffCommandArgs(
    headOid: string | null,
    format: "patch" | "numstat",
    paths: readonly string[]
): string[] {
    const args = [
        "--no-optional-locks",
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames=50%",
        "--submodule=short",
        ...(format === "patch"
            ? ["--patch", "--unified=3"]
            : ["--numstat", "-z"]),
    ];
    if (headOid) args.push(headOid);
    args.push("--", ...paths);
    return args;
}

function unavailableDiff(
    reason: GitRepositoryUnavailableReason,
    message: string
): GitDiffSnapshotResult {
    return {status: "unavailable", reason, message};
}

function countHunkLines(hunks: GitDiffFile["hunks"]): number {
    return hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
}

function truncateHunks(
    hunks: GitDiffFile["hunks"],
    limit: number
): GitDiffFile["hunks"] {
    const kept = [];
    let remaining = limit;
    for (const hunk of hunks) {
        if (remaining <= 0) break;
        const lines = hunk.lines.slice(0, remaining);
        if (lines.length > 0) kept.push({...hunk, lines});
        remaining -= lines.length;
    }
    return kept;
}

function applyHunkBudget(files: GitDiffFile[]): GitDiffFile[] {
    let remaining = MAX_DIFF_HUNK_LINES;
    return files.map((file) => {
        const total = countHunkLines(file.hunks);
        if (total <= remaining) {
            remaining -= total;
            return file;
        }
        const hunks = truncateHunks(file.hunks, remaining);
        const kept = countHunkLines(hunks);
        remaining = 0;
        return {
            ...file,
            hunks,
            diffStatus: file.diffStatus === "unavailable"
                ? "unavailable" as const
                : "truncated" as const,
            omittedDiffLines: total - kept,
        };
    });
}

function fileFromTrackedDiff(
    status: GitFileStatus,
    numstat: GitNumstatEntry | undefined,
    patch: ParsedPatchFile | undefined
): GitDiffFile | undefined {
    if (!numstat && !patch && status.kind !== "conflicted") return undefined;
    if (status.kind === "conflicted") {
        return {
            status,
            additions: numstat?.additions ?? null,
            deletions: numstat?.deletions ?? null,
            binary: false,
            hunks: [],
            diffStatus: "unavailable",
            unavailableReason: "conflict",
        };
    }
    const binary = numstat?.binary ?? patch?.binary ?? false;
    return {
        status,
        additions: numstat?.additions ?? null,
        deletions: numstat?.deletions ?? null,
        binary,
        hunks: patch?.hunks ?? [],
        diffStatus: binary ? "unavailable" : "complete",
        ...(binary ? {unavailableReason: "binary" as const} : {}),
    };
}

async function diffStandaloneFile(input: {
    repositoryRoot: string;
    status: GitFileStatus;
    signal: AbortSignal;
}): Promise<{file?: GitDiffFile; patch: string}> {
    let stat;
    try {
        stat = await lstat(resolve(input.repositoryRoot, input.status.path));
    } catch (error) {
        if (
            error && typeof error === "object" && "code" in error &&
            (error as {code?: string}).code === "ENOENT"
        ) {
            return {
                patch: "",
                file: {
                    status: input.status,
                    additions: null,
                    deletions: null,
                    binary: false,
                    hunks: [],
                    diffStatus: "unavailable",
                    unavailableReason: "missing",
                },
            };
        }
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        return {
            patch: "",
            file: {
                status: input.status,
                additions: null,
                deletions: null,
                binary: false,
                hunks: [],
                diffStatus: "unavailable",
                unavailableReason: stat.isSymbolicLink()
                    ? "symlink"
                    : "unsupported-file",
            },
        };
    }
    const result = await runGitCommand(input.repositoryRoot, [
        "--no-optional-locks",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=3",
        "--",
        "/dev/null",
        input.status.path,
    ], input.signal);
    if (result.code !== 0 && result.code !== 1) {
        throw new Error(formatGitProcessError(result));
    }
    const patchText = result.stdout.toString("utf8");
    const parsed = parsePatch(patchText)[0];
    if (!parsed) {
        return {
            patch: patchText,
            file: {
                status: input.status,
                additions: null,
                deletions: null,
                binary: false,
                hunks: [],
                diffStatus: "unavailable",
                unavailableReason: "parse-error",
            },
        };
    }
    const hunks = parsed.hunks.map(convertUnifiedDiffHunk);
    const additions = hunks.reduce(
        (sum, hunk) => sum + hunk.lines.filter((line) => line.type === "add").length,
        0
    );
    const deletions = hunks.reduce(
        (sum, hunk) => sum + hunk.lines.filter((line) => line.type === "remove").length,
        0
    );
    const binary = parsed.isBinary === true;
    return {
        patch: patchText,
        file: {
            status: input.status,
            additions: binary ? null : additions,
            deletions: binary ? null : deletions,
            binary,
            hunks: binary ? [] : hunks,
            diffStatus: binary ? "unavailable" : "complete",
            ...(binary ? {unavailableReason: "binary" as const} : {}),
        },
    };
}

export class GitWorkspaceRuntime implements GitWorkspaceRuntimeLike {
    constructor(private readonly cwd: string) {}

    status(signal: AbortSignal): Promise<GitRepositorySnapshotResult> {
        return readGitRepositorySnapshot(this.cwd, signal);
    }

    async diff(signal: AbortSignal): Promise<GitDiffSnapshotResult> {
        const repository = await this.status(signal);
        if (repository.status === "unavailable") return repository;
        const {snapshot} = repository;
        const omittedFiles = Math.max(0, snapshot.files.length - MAX_DIFF_FILES);
        const selectedStatuses = snapshot.files.slice(0, MAX_DIFF_FILES);
        const standaloneStatuses = selectedStatuses.filter((file) =>
            file.kind === "untracked" || snapshot.unborn
        );
        const standalonePaths = new Set(standaloneStatuses.map((file) => file.path));
        const trackedStatuses = selectedStatuses.filter(
            (file) => !standalonePaths.has(file.path)
        );

        let trackedPatch = "";
        let trackedFiles: GitDiffFile[] = [];
        if (trackedStatuses.length > 0) {
            const paths = [...new Set(trackedStatuses.flatMap((file) => [
                file.path,
                ...(file.originalPath ? [file.originalPath] : []),
            ]))];
            const [patchResult, numstatResult] = await Promise.all([
                runGitCommand(
                    snapshot.repositoryRoot,
                    diffCommandArgs(snapshot.headOid, "patch", paths),
                    signal
                ),
                runGitCommand(
                    snapshot.repositoryRoot,
                    diffCommandArgs(snapshot.headOid, "numstat", paths),
                    signal
                ),
            ]);
            const failed = patchResult.code !== 0 ? patchResult :
                numstatResult.code !== 0 ? numstatResult : undefined;
            if (failed) {
                return unavailableDiff(
                    failed.termination.kind === "aborted"
                        ? "cancelled"
                        : "command-failed",
                    formatGitProcessError(failed)
                );
            }
            trackedPatch = patchResult.stdout.toString("utf8");
            try {
                const stats = new Map(
                    parseGitNumstatZ(numstatResult.stdout).map((entry) => [entry.path, entry])
                );
                const patches = new Map(
                    parsePatchFiles(trackedPatch).map((entry) => [entry.path, entry])
                );
                trackedFiles = trackedStatuses.flatMap((status) => {
                    const file = fileFromTrackedDiff(
                        status,
                        stats.get(status.path),
                        patches.get(status.path)
                    );
                    return file ? [file] : [];
                });
            } catch (error) {
                return unavailableDiff(
                    "command-failed",
                    `无法解析 Git diff: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }

        let standalone: Array<{file?: GitDiffFile; patch: string}>;
        try {
            standalone = await mapWithConcurrencyLimit(
                standaloneStatuses,
                4,
                (status) => diffStandaloneFile({
                    repositoryRoot: snapshot.repositoryRoot,
                    status,
                    signal,
                })
            );
        } catch (error) {
            return unavailableDiff(
                signal.aborted ? "cancelled" : "command-failed",
                signal.aborted
                    ? "Git 操作已取消"
                    : `无法读取独立文件差异: ${
                        error instanceof Error ? error.message : String(error)
                    }`
            );
        }
        if (signal.aborted) {
            return unavailableDiff("cancelled", "Git 操作已取消");
        }
        const files = applyHunkBudget([
            ...trackedFiles,
            ...standalone.flatMap((item) => item.file ? [item.file] : []),
        ].sort((left, right) =>
            compareGitText(left.status.path, right.status.path)
        ));
        return {
            status: "available",
            snapshot: {
                version: 1,
                repository: snapshot,
                files,
                patch: [
                    trackedPatch.trimEnd(),
                    ...standalone.map((item) => item.patch.trimEnd()),
                ].filter(Boolean).join("\n"),
                truncated: omittedFiles > 0 || files.some(
                    (file) => file.diffStatus === "truncated"
                ),
                omittedFiles,
            },
        };
    }
}

export function createGitWorkspaceRuntime(cwd: string): GitWorkspaceRuntimeLike {
    return new GitWorkspaceRuntime(cwd);
}
