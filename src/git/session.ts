import {realpathSync} from "node:fs";
import {isAbsolute, relative, resolve} from "node:path";
import type {GitWorkspaceRuntimeLike} from "./runtime.js";
import type {
    GitFileStatus,
    GitProvenanceHint,
    GitRepositorySnapshot,
    GitSessionDiagnostic,
    GitSessionDiffSnapshotResult,
    GitSessionFileStatus,
    GitSessionRepositorySnapshot,
    GitSessionRepositorySnapshotResult,
    GitSessionState,
    GitSessionTraceability,
} from "./types.js";
import {compareGitText} from "./sort.js";

const MAX_BASELINE_PATHS = 10_000;
const MAX_DIAGNOSTICS = 16;
const MAX_DIAGNOSTIC_CHARS = 500;

export interface CreateGitSessionRuntimeOptions {
    cwd: string;
    workspace: GitWorkspaceRuntimeLike;
    persistedState?: GitSessionState;
    resumed: boolean;
}

export interface GitSessionRuntimeLike {
    initialize(): Promise<void>;

    status(signal: AbortSignal): Promise<GitSessionRepositorySnapshotResult>;

    diff(signal: AbortSignal): Promise<GitSessionDiffSnapshotResult>;

    observePaths(paths: readonly string[], cwd: string): void;

    observeRepositoryPaths(paths: readonly string[]): void;

    getState(): GitSessionState | undefined;
}

interface PendingObservedPath {
    path: string;
    cwd?: string;
    repositoryRelative: boolean;
}

function cloneFileStatus(file: GitFileStatus): GitFileStatus {
    return {...file};
}

function isGitStatusCode(value: unknown): boolean {
    return value === null || value === "M" || value === "T" || value === "A" ||
        value === "D" || value === "R" || value === "C" || value === "U";
}

function normalizeFileStatus(value: unknown): GitFileStatus | undefined {
    if (!value || typeof value !== "object") return undefined;
    const file = value as Partial<GitFileStatus>;
    if (
        typeof file.path !== "string" || file.path.length === 0 ||
        (file.originalPath !== undefined && typeof file.originalPath !== "string") ||
        !isGitStatusCode(file.indexStatus) ||
        !isGitStatusCode(file.worktreeStatus) ||
        typeof file.staged !== "boolean" ||
        typeof file.unstaged !== "boolean" ||
        (file.submodule !== null && typeof file.submodule !== "string") ||
        !(
            file.kind === "added" || file.kind === "modified" ||
            file.kind === "deleted" || file.kind === "renamed" ||
            file.kind === "copied" || file.kind === "type-changed" ||
            file.kind === "untracked" || file.kind === "conflicted"
        )
    ) return undefined;
    return {
        path: file.path,
        ...(file.originalPath === undefined ? {} : {originalPath: file.originalPath}),
        kind: file.kind,
        indexStatus: file.indexStatus as GitFileStatus["indexStatus"],
        worktreeStatus: file.worktreeStatus as GitFileStatus["worktreeStatus"],
        staged: file.staged,
        unstaged: file.unstaged,
        submodule: file.submodule,
    };
}

function normalizeDiagnostics(value: unknown): GitSessionDiagnostic[] {
    if (!Array.isArray(value)) return [];
    return value.slice(-MAX_DIAGNOSTICS).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const diagnostic = item as Partial<GitSessionDiagnostic>;
        if (
            !(
                diagnostic.code === "resume-baseline" ||
                diagnostic.code === "repository-changed" ||
                diagnostic.code === "head-changed" ||
                diagnostic.code === "paths-truncated"
            ) ||
            typeof diagnostic.message !== "string" ||
            typeof diagnostic.timestamp !== "string"
        ) return [];
        return [{
            code: diagnostic.code,
            message: diagnostic.message.slice(0, MAX_DIAGNOSTIC_CHARS),
            timestamp: diagnostic.timestamp,
        }];
    });
}

export function normalizeGitSessionState(value: unknown): GitSessionState | undefined {
    if (!value || typeof value !== "object") return undefined;
    const state = value as Partial<GitSessionState>;
    if (
        state.version !== 1 ||
        typeof state.repositoryIdentity !== "string" ||
        typeof state.repositoryRoot !== "string" ||
        (state.initialHeadOid !== null && typeof state.initialHeadOid !== "string") ||
        (state.initialBranch !== null && typeof state.initialBranch !== "string") ||
        (state.lastKnownHeadOid !== null && typeof state.lastKnownHeadOid !== "string") ||
        (state.lastKnownBranch !== null && typeof state.lastKnownBranch !== "string") ||
        !(
            state.traceability === "complete" ||
            state.traceability === "resume-baseline" ||
            state.traceability === "repository-reset"
        ) ||
        typeof state.createdAt !== "string" ||
        !Array.isArray(state.initialFiles) ||
        !Array.isArray(state.observedPaths)
    ) return undefined;

    const initialFiles = state.initialFiles
        .slice(0, MAX_BASELINE_PATHS)
        .map(normalizeFileStatus)
        .filter((file): file is GitFileStatus => file !== undefined);
    const observedPaths = [...new Set(
        state.observedPaths
            .slice(0, MAX_BASELINE_PATHS)
            .filter((path): path is string => typeof path === "string" && path.length > 0)
    )].sort(compareGitText);
    return {
        version: 1,
        repositoryIdentity: state.repositoryIdentity,
        repositoryRoot: state.repositoryRoot,
        initialHeadOid: state.initialHeadOid,
        initialBranch: state.initialBranch,
        initialFiles,
        observedPaths,
        lastKnownHeadOid: state.lastKnownHeadOid,
        lastKnownBranch: state.lastKnownBranch,
        traceability: state.traceability,
        createdAt: state.createdAt,
        diagnostics: normalizeDiagnostics(state.diagnostics),
    };
}

function diagnostic(
    code: GitSessionDiagnostic["code"],
    message: string
): GitSessionDiagnostic {
    return {
        code,
        message: message.slice(0, MAX_DIAGNOSTIC_CHARS),
        timestamp: new Date().toISOString(),
    };
}

function boundedInitialFiles(snapshot: GitRepositorySnapshot): {
    files: GitFileStatus[];
    truncated: boolean;
} {
    return {
        files: snapshot.files.slice(0, MAX_BASELINE_PATHS).map(cloneFileStatus),
        truncated: snapshot.files.length > MAX_BASELINE_PATHS,
    };
}

function createState(
    snapshot: GitRepositorySnapshot,
    traceability: GitSessionTraceability,
    previousDiagnostics: readonly GitSessionDiagnostic[] = []
): GitSessionState {
    const initial = boundedInitialFiles(snapshot);
    const diagnostics = [...previousDiagnostics];
    if (traceability === "resume-baseline") {
        diagnostics.push(diagnostic(
            "resume-baseline",
            "旧 Session 没有 Git Baseline；当前状态已作为 Resume Baseline，无法追溯 Resume 前的变更来源。"
        ));
    } else if (traceability === "repository-reset") {
        diagnostics.push(diagnostic(
            "repository-changed",
            "Session 对应的 Git Repository 已变化；Baseline 已按当前仓库重建。"
        ));
    }
    if (initial.truncated) {
        diagnostics.push(diagnostic(
            "paths-truncated",
            `初始 Dirty Path 超过 ${MAX_BASELINE_PATHS} 个，Baseline 已截断。`
        ));
    }
    return {
        version: 1,
        repositoryIdentity: snapshot.repositoryIdentity,
        repositoryRoot: snapshot.repositoryRoot,
        initialHeadOid: snapshot.headOid,
        initialBranch: snapshot.branch,
        initialFiles: initial.files,
        observedPaths: [],
        lastKnownHeadOid: snapshot.headOid,
        lastKnownBranch: snapshot.branch,
        traceability,
        createdAt: new Date().toISOString(),
        diagnostics: diagnostics.slice(-MAX_DIAGNOSTICS),
    };
}

function createProvenanceClassifier(
    state: GitSessionState
): (path: string, dirty?: boolean) => GitProvenanceHint {
    const preExistingPaths = new Set(
        state.initialFiles.map((file) => file.path)
    );
    const observedPaths = new Set(state.observedPaths);
    return (path: string, dirty = true): GitProvenanceHint => {
        if (!dirty) return "clean";
        const preExisting = preExistingPaths.has(path);
        const observed = observedPaths.has(path);
        if (preExisting && observed) return "mixed";
        if (preExisting) return "pre-existing";
        if (observed) return "pillar-observed";
        return "external-or-unknown";
    };
}

function withProvenance(
    file: GitFileStatus,
    classify: (path: string, dirty?: boolean) => GitProvenanceHint
): GitSessionFileStatus {
    return {
        ...file,
        provenance: classify(file.path),
    };
}

function sessionSnapshot(
    snapshot: GitRepositorySnapshot,
    state: GitSessionState,
    classify = createProvenanceClassifier(state)
): GitSessionRepositorySnapshot {
    return {
        ...snapshot,
        files: snapshot.files.map((file) => withProvenance(file, classify)),
        session: state,
    };
}

function safeRelativePath(root: string, absolutePath: string): string | undefined {
    const path = relative(root, absolutePath);
    if (!path || path.startsWith("..") || isAbsolute(path) || path.includes("\0")) {
        return undefined;
    }
    return path;
}

function canonicalDirectory(path: string): string {
    try {
        return realpathSync.native(path);
    } catch {
        return resolve(path);
    }
}

function canonicalObservedPath(path: string, cwd: string): string {
    const lexicalCwd = resolve(cwd);
    const canonicalCwd = canonicalDirectory(cwd);
    const lexicalPath = isAbsolute(path)
        ? resolve(path)
        : resolve(canonicalCwd, path);
    const relativeToCwd = isAbsolute(path)
        ? safeRelativePath(lexicalCwd, lexicalPath)
        : undefined;
    const candidate = relativeToCwd
        ? resolve(canonicalCwd, relativeToCwd)
        : lexicalPath;
    try {
        return realpathSync.native(candidate);
    } catch {
        // Delete/Rewind 后路径可以不存在；这时只做 lexical repository boundary 校验。
        return candidate;
    }
}

class GitSessionRuntime implements GitSessionRuntimeLike {
    private state?: GitSessionState;
    private readonly pendingObservedPaths: PendingObservedPath[] = [];
    private readonly initialization: Promise<void>;
    constructor(private readonly options: CreateGitSessionRuntimeOptions) {
        this.state = normalizeGitSessionState(options.persistedState);
        this.initialization = this.captureInitialState();
    }

    initialize(): Promise<void> {
        return this.initialization;
    }

    getState(): GitSessionState | undefined {
        const normalized = normalizeGitSessionState(this.state);
        return normalized ? {
            ...normalized,
            initialFiles: normalized.initialFiles.map(cloneFileStatus),
            observedPaths: [...normalized.observedPaths],
            diagnostics: normalized.diagnostics.map((item) => ({...item})),
        } : undefined;
    }

    observePaths(paths: readonly string[], cwd: string): void {
        for (const path of paths) {
            this.pendingObservedPaths.push({path, cwd, repositoryRelative: false});
        }
        this.flushObservedPaths();
    }

    observeRepositoryPaths(paths: readonly string[]): void {
        for (const path of paths) {
            this.pendingObservedPaths.push({path, repositoryRelative: true});
        }
        this.flushObservedPaths();
    }

    async status(signal: AbortSignal): Promise<GitSessionRepositorySnapshotResult> {
        await this.initialization;
        const result = await this.options.workspace.status(signal);
        if (result.status === "unavailable") return result;
        const state = this.reconcile(result.snapshot);
        return {
            status: "available",
            snapshot: sessionSnapshot(result.snapshot, state),
        };
    }

    async diff(signal: AbortSignal): Promise<GitSessionDiffSnapshotResult> {
        await this.initialization;
        const result = await this.options.workspace.diff(signal);
        if (result.status === "unavailable") return result;
        const state = this.reconcile(result.snapshot.repository);
        const classify = createProvenanceClassifier(state);
        return {
            status: "available",
            snapshot: {
                ...result.snapshot,
                repository: sessionSnapshot(
                    result.snapshot.repository,
                    state,
                    classify
                ),
                files: result.snapshot.files.map((file) => ({
                    ...file,
                    status: withProvenance(file.status, classify),
                })),
            },
        };
    }

    private async captureInitialState(): Promise<void> {
        try {
            const result = await this.options.workspace.status(
                new AbortController().signal
            );
            if (result.status === "available") this.reconcile(result.snapshot);
        } catch {
            // Git Session 是增强能力；初始化异常不能阻止 Root Runtime 启动。
            // 后续 status/diff 会再次读取真实仓库并返回准确错误。
        } finally {
            this.flushObservedPaths();
        }
    }

    private reconcile(snapshot: GitRepositorySnapshot): GitSessionState {
        if (!this.state) {
            this.state = createState(
                snapshot,
                this.options.resumed ? "resume-baseline" : "complete"
            );
            this.flushObservedPaths();
            return this.state;
        }
        if (
            this.state.repositoryIdentity !== snapshot.repositoryIdentity ||
            this.state.repositoryRoot !== snapshot.repositoryRoot
        ) {
            this.state = createState(
                snapshot,
                "repository-reset",
                this.state.diagnostics
            );
            this.flushObservedPaths();
            return this.state;
        }
        if (
            this.state.lastKnownHeadOid !== snapshot.headOid ||
            this.state.lastKnownBranch !== snapshot.branch
        ) {
            const before = this.state.lastKnownHeadOid?.slice(0, 12) ?? "unborn";
            const after = snapshot.headOid?.slice(0, 12) ?? "unborn";
            this.state = {
                ...this.state,
                lastKnownHeadOid: snapshot.headOid,
                lastKnownBranch: snapshot.branch,
                diagnostics: [
                    ...this.state.diagnostics,
                    diagnostic(
                        "head-changed",
                        `Git HEAD/Branch 在 Session 中发生变化（${before} -> ${after}）；来源标签已按当前 Snapshot 重新计算。`
                    ),
                ].slice(-MAX_DIAGNOSTICS),
            };
        }
        this.flushObservedPaths();
        return this.state;
    }

    private flushObservedPaths(): void {
        if (!this.state || this.pendingObservedPaths.length === 0) return;
        const observed = new Set(this.state.observedPaths);
        let truncated = false;
        while (this.pendingObservedPaths.length > 0) {
            const pending = this.pendingObservedPaths.shift()!;
            let path: string | undefined;
            if (pending.repositoryRelative) {
                path = safeRelativePath(
                    this.state.repositoryRoot,
                    resolve(this.state.repositoryRoot, pending.path)
                );
            } else {
                const absolutePath = canonicalObservedPath(
                    pending.path,
                    pending.cwd ?? this.options.cwd
                );
                path = safeRelativePath(this.state.repositoryRoot, absolutePath);
            }
            if (path && observed.size < MAX_BASELINE_PATHS) {
                observed.add(path);
            } else if (path && !observed.has(path)) {
                truncated = true;
            }
        }
        this.state = {
            ...this.state,
            observedPaths: [...observed].sort(compareGitText),
            ...(truncated && !this.state.diagnostics.some(
                (item) => item.code === "paths-truncated"
            )
                ? {
                    diagnostics: [
                        ...this.state.diagnostics,
                        diagnostic(
                            "paths-truncated",
                            `Pillar observed path 超过 ${MAX_BASELINE_PATHS} 个，后续来源提示可能退化为 external-or-unknown。`
                        ),
                    ].slice(-MAX_DIAGNOSTICS),
                }
                : {}),
        };
    }
}

export function createGitSessionRuntime(
    options: CreateGitSessionRuntimeOptions
): GitSessionRuntimeLike {
    return new GitSessionRuntime(options);
}
