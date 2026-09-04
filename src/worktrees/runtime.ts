import {realpath} from "node:fs/promises";
import {join, resolve} from "node:path";
import {createDisabledFileCheckpointRuntime} from "../checkpoints/index.js";
import {createDirectoryAccessRuntime} from "../permissions/index.js";
import {
    createGitCommandRunner,
    formatGitProcessError,
    type GitCommandRunner,
} from "../git/process.js";
import {readGitRepositorySnapshot} from "../git/status.js";
import {getProjectStorageDirectory, type PillarStorageLayout} from "../persistence/index.js";
import {loadProjectInstructions} from "../prompt/instructions.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";
import {createFileStateTracker} from "../tools/shared/fileState.js";
import type {ToolContext} from "../tools/types.js";
import {
    assertWorktreesIgnored,
    inspectWorktree,
    isRegisteredWorktree,
    readWorktreeDiff,
    resolveMainWorktreeRoot,
} from "./git.js";
import {WorktreeManifestStore} from "./manifest.js";
import {
    assertRecordedWorktreePath,
    assertWorktreeParentSafety,
    mapSourceCwdToWorktree,
    prepareWorktreeDirectory,
    worktreeBranch,
} from "./paths.js";
import type {
    AgentWorktreeRecord,
    AvailableWorktreeInspection,
    WorktreeLifecycleResult,
    WorktreeRuntimeLike,
} from "./types.js";

interface RemoveResult {
    worktreeRemoved: boolean;
    branchRemoved: boolean;
    issue?: string;
}

class WorktreeRuntime implements WorktreeRuntimeLike {
    constructor(
        private readonly sourceCwd: string,
        private readonly manifests: WorktreeManifestStore,
        private readonly runGit: GitCommandRunner
    ) {}

    async create(input: {
        taskId: string;
        sessionId: string;
        signal: AbortSignal;
    }): Promise<AgentWorktreeRecord> {
        const repository = await readGitRepositorySnapshot(
            this.runGit,
            this.sourceCwd,
            input.signal
        );
        if (repository.status === "unavailable") {
            const prefix = repository.reason === "not-git-repository"
                ? "当前目录不是 Git repository"
                : "无法检查来源工作区状态";
            throw new Error(`${prefix}：${repository.message}`);
        }
        const {snapshot} = repository;
        if (snapshot.operation !== "normal") {
            throw new Error(`Git 当前处于 ${snapshot.operation} 状态，不能创建 Worktree Agent`);
        }
        if (!snapshot.headOid) throw new Error("无法读取 HEAD：repository 尚无 Commit");

        const sourceCwd = await realpath(this.sourceCwd);
        const sourceGitRoot = await realpath(snapshot.repositoryRoot);
        const mainGitRoot = await resolveMainWorktreeRoot(this.runGit, sourceGitRoot);
        await assertWorktreeParentSafety(mainGitRoot);
        await assertWorktreesIgnored(this.runGit, mainGitRoot);
        const branch = worktreeBranch(input.taskId);
        const branchStatus = await this.runGit(sourceGitRoot, [
            "show-ref", "--verify", "--quiet", `refs/heads/${branch}`,
        ], input.signal);
        if (branchStatus.code === 0) {
            throw new Error(`Worktree 临时分支已存在，拒绝覆盖: ${branch}`);
        }
        if (branchStatus.code !== 1) {
            throw new Error(`无法检查 Worktree 临时分支：${formatGitProcessError(branchStatus)}`);
        }
        const prepared = await prepareWorktreeDirectory(mainGitRoot, input.taskId);
        const created = await this.runGit(sourceGitRoot, [
            "worktree", "add", "-b", branch, prepared.path, snapshot.headOid,
        ], input.signal);
        if (created.code !== 0 || input.signal.aborted) {
            await this.removeCreatedWorktree(sourceGitRoot, prepared.path, branch);
            const issue = input.signal.aborted
                ? "Git Worktree 创建已取消"
                : formatGitProcessError(created);
            throw new Error(`创建 Git Worktree 失败：${issue}`);
        }

        const record: AgentWorktreeRecord = {
            version: 2,
            taskId: input.taskId,
            sessionId: input.sessionId,
            sourceCwd,
            sourceGitRoot,
            mainGitRoot,
            path: prepared.path,
            branch,
            baseCommit: snapshot.headOid,
            sourceHadChanges: !snapshot.clean,
            createdAt: new Date().toISOString(),
            state: "active",
        };
        try {
            await this.manifests.create(record);
        } catch (error) {
            await this.removeCreatedWorktree(sourceGitRoot, prepared.path, branch);
            throw error;
        }
        return record;
    }

    async load(
        taskId: string,
        sessionId: string
    ): Promise<AgentWorktreeRecord | undefined> {
        const record = await this.manifests.load(taskId, sessionId);
        if (!record) return undefined;
        assertRecordedWorktreePath(record);
        const [currentCwd, currentRepository] = await Promise.all([
            realpath(this.sourceCwd),
            readGitRepositorySnapshot(this.runGit, this.sourceCwd),
        ]);
        if (currentRepository.status !== "available") {
            throw new Error("无法核对 Worktree Manifest 的来源 repository");
        }
        const currentRoot = await realpath(currentRepository.snapshot.repositoryRoot);
        const currentMainRoot = await resolveMainWorktreeRoot(this.runGit, currentRoot);
        if (
            currentCwd !== record.sourceCwd ||
            currentRoot !== record.sourceGitRoot ||
            currentMainRoot !== record.mainGitRoot
        ) {
            throw new Error("Worktree Manifest 与当前 checkout 不匹配");
        }
        return record;
    }

    async createAgentContext(
        parentContext: ToolContext,
        record: AgentWorktreeRecord
    ): Promise<ToolContext> {
        const mapped = await mapSourceCwdToWorktree({
            sourceCwd: record.sourceCwd,
            sourceGitRoot: record.sourceGitRoot,
            worktreePath: record.path,
        });
        const instructions = await loadProjectInstructions({
            cwd: mapped.cwd,
            boundary: mapped.root,
            sources: ["project", "local"],
        });
        return {
            ...parentContext,
            cwd: mapped.cwd,
            workspaceBoundary: mapped.root,
            directoryAccess: createDirectoryAccessRuntime({
                cwd: mapped.cwd,
                hardBoundary: mapped.root,
                allowGrants: false,
            }),
            permissionMode: "default",
            collaborationMode: "build",
            permissionPromptPolicy: "never",
            permissionRules: {
                allow: [],
                ask: [],
                deny: [...parentContext.permissionRules.deny],
            },
            canUseTool: async () => ({
                behavior: "deny",
                message: "Worktree Agent 不允许交互式权限确认",
            }),
            setPermissionMode() {},
            setCollaborationMode() {},
            setTodos() {},
            skills: [],
            instructions,
            compactState: {...parentContext.compactState},
            fileState: createFileStateTracker(),
            fileCheckpoints: createDisabledFileCheckpointRuntime(),
            gitSession: undefined,
            mcpManager: undefined,
            tasks: undefined,
            subagentLauncher: undefined,
        };
    }

    inspect(record: AgentWorktreeRecord) {
        return inspectWorktree(this.runGit, record);
    }

    async finish(record: AgentWorktreeRecord): Promise<WorktreeLifecycleResult> {
        let inspection: WorktreeLifecycleResult["inspection"];
        const updated = await this.manifests.update(
            record.taskId,
            record.sessionId,
            async (current) => {
                if (current.state === "cleaned") return current;
                inspection = await this.inspect(current);
                if (inspection.status === "unavailable" || inspection.hasWork) {
                    return {
                        ...current,
                        state: "changed",
                        ...(inspection.status === "unavailable"
                            ? {issue: inspection.issue}
                            : {issue: undefined}),
                    };
                }
                const removed = await this.remove(current);
                if (!removed.worktreeRemoved) {
                    return {
                        ...current,
                        state: "changed",
                        issue: removed.issue ?? "无变更 Worktree 清理失败，已保留",
                    };
                }
                return {
                    ...current,
                    state: "cleaned",
                    cleanupReason: "no_changes",
                    ...(removed.branchRemoved
                        ? {issue: undefined}
                        : {issue: removed.issue ?? "Worktree 已清理，但临时 Git branch 删除失败"}),
                };
            }
        );
        return {...(inspection ? {inspection} : {}), record: updated};
    }

    readDiff(
        record: AgentWorktreeRecord,
        inspection: AvailableWorktreeInspection
    ) {
        return readWorktreeDiff(this.runGit, record, inspection);
    }

    async discard(record: AgentWorktreeRecord): Promise<WorktreeLifecycleResult> {
        let inspection: WorktreeLifecycleResult["inspection"];
        const updated = await this.manifests.update(
            record.taskId,
            record.sessionId,
            async (current) => {
                if (current.state === "active") {
                    throw new Error("Worktree Agent 仍在运行，不能 discard");
                }
                if (current.state === "cleaned") {
                    throw new Error("Worktree 已被清理，不能 discard");
                }
                inspection = await this.inspect(current);
                if (inspection.status === "unavailable" || !inspection.registered) {
                    throw new Error(
                        `无法安全确认 Worktree 所有权，已拒绝删除：${inspection.issue}`
                    );
                }
                const removed = await this.remove(current);
                if (!removed.worktreeRemoved) {
                    throw new Error(removed.issue ?? "Git Worktree 删除失败，原目录已保留");
                }
                return {
                    ...current,
                    state: "cleaned",
                    cleanupReason: "explicit_discard",
                    ...(removed.branchRemoved
                        ? {issue: undefined}
                        : {issue: removed.issue ?? "Worktree 已删除，但临时 Git branch 删除失败"}),
                };
            }
        );
        return {...(inspection ? {inspection} : {}), record: updated};
    }

    private async remove(record: AgentWorktreeRecord): Promise<RemoveResult> {
        assertRecordedWorktreePath(record);
        if (!await isRegisteredWorktree(this.runGit, record)) {
            return {
                worktreeRemoved: false,
                branchRemoved: false,
                issue: "Worktree 不在当前 Git repository 的注册列表中",
            };
        }
        const removed = await this.runGit(record.sourceGitRoot, [
            "worktree", "remove", "--force", record.path,
        ]);
        if (removed.code !== 0) {
            return {
                worktreeRemoved: false,
                branchRemoved: false,
                issue: `Git Worktree 删除失败：${formatGitProcessError(removed)}`,
            };
        }
        const branch = await this.runGit(record.sourceGitRoot, [
            "branch", "-D", record.branch,
        ]);
        return {
            worktreeRemoved: true,
            branchRemoved: branch.code === 0,
            ...(branch.code === 0
                ? {}
                : {issue: `临时 Git branch 删除失败：${formatGitProcessError(branch)}`}),
        };
    }

    private async removeCreatedWorktree(
        gitRoot: string,
        path: string,
        branch: string
    ): Promise<void> {
        await this.runGit(gitRoot, ["worktree", "remove", "--force", path]);
        await this.runGit(gitRoot, ["branch", "-D", branch]);
    }
}

export function createWorktreeRuntime(
    storage: PillarStorageLayout,
    cwd: string,
    environment: ChildProcessEnvironment
): WorktreeRuntimeLike {
    const manifests = new WorktreeManifestStore(
        join(getProjectStorageDirectory(storage, cwd), "worktrees", "manifests")
    );
    return new WorktreeRuntime(
        resolve(cwd),
        manifests,
        createGitCommandRunner(environment)
    );
}
