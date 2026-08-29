import type {ToolResultStore} from "../toolResults/index.js";
import type {ToolContext} from "../tools/types.js";
import type {
    AgentWorktreeRecord,
    AvailableWorktreeInspection,
    WorktreeInspection,
    WorktreeRuntimeLike,
} from "../worktrees/index.js";
import type {ManagedAgentTask} from "./managed.js";
import {appendTaskIssue, worktreeSnapshot} from "./managed.js";
import type {AgentTaskSnapshot, StartAgentTaskInput} from "./types.js";

const WORKTREE_DIFF_PREVIEW_CHARS = 12_000;

interface CapturedWorktreeDiff {
    stat: string;
    preview: string;
    result: NonNullable<AgentTaskSnapshot["worktreeDiffResult"]>;
}

function worktreePrompt(record: AgentWorktreeRecord, prompt: string): string {
    return [
        "[Worktree isolation]",
        `Your isolated checkout is ${record.path}.`,
        `It was created from commit ${record.baseCommit}.`,
        record.sourceHadChanges
            ? "The source checkout had uncommitted changes. They are not present in this Worktree; do not assume or access them."
            : "The source checkout had no uncommitted changes when this Worktree was created.",
        "Modify only this Worktree. The Root Agent will inspect, commit, and integrate the result with Git.",
        "",
        prompt,
    ].join("\n");
}

export class TaskWorktreeManager {
    private readonly creatingSessions = new Set<string>();

    constructor(private readonly worktrees: WorktreeRuntimeLike) {}

    async prepare(
        taskId: string,
        sessionId: string,
        input: StartAgentTaskInput,
        hasActiveWorktree: boolean
    ): Promise<{
        context: ToolContext;
        input: StartAgentTaskInput;
        worktree?: AgentWorktreeRecord;
    }> {
        if (input.isolation !== "worktree") {
            return {context: input.parentContext, input};
        }
        if (this.creatingSessions.has(sessionId) || hasActiveWorktree) {
            throw new Error("当前 Session 已有一个运行中的 Worktree Agent");
        }
        this.creatingSessions.add(sessionId);
        let worktree: AgentWorktreeRecord | undefined;
        try {
            worktree = await this.worktrees.create({
                taskId,
                sessionId,
                signal: input.parentContext.signal,
            });
            return {
                worktree,
                context: await this.worktrees.createAgentContext(
                    input.parentContext,
                    worktree
                ),
                input: {
                    ...input,
                    request: {
                        ...input.request,
                        prompt: worktreePrompt(worktree, input.request.prompt),
                    },
                },
            };
        } catch (error) {
            if (worktree) await this.worktrees.finish(worktree).catch(() => undefined);
            throw error;
        } finally {
            this.creatingSessions.delete(sessionId);
        }
    }

    async finish(task: ManagedAgentTask): Promise<void> {
        if (task.worktree?.state !== "active") return;
        try {
            const lifecycle = await this.worktrees.finish(task.worktree);
            task.worktree = lifecycle.record;
            task.worktreeInspection = lifecycle.inspection;
            if (
                lifecycle.record.state === "changed" &&
                lifecycle.inspection?.status === "available"
            ) {
                await this.captureManagedDiff(task, lifecycle.inspection);
            }
        } catch (error) {
            const issue = error instanceof Error ? error.message : String(error);
            task.worktree = {
                ...task.worktree,
                state: "changed",
                issue: `Worktree 检查失败，已保留：${issue}`,
            };
            appendTaskIssue(task, `Worktree 检查失败：${issue}`);
        }
    }

    async release(record: AgentWorktreeRecord | undefined): Promise<void> {
        if (record) await this.worktrees.finish(record).catch(() => undefined);
    }

    async loadRecord(
        sessionId: string,
        taskId: string,
        managed?: ManagedAgentTask,
        archived?: AgentTaskSnapshot
    ): Promise<AgentWorktreeRecord> {
        if (managed?.worktree) return managed.worktree;
        if (!archived || archived.owner.sessionId !== sessionId) {
            throw new Error(`Agent Task 不存在: ${taskId}`);
        }
        const record = await this.worktrees.load(taskId, sessionId);
        if (!record) throw new Error(`Task ${taskId} 没有关联 Worktree`);
        return record;
    }

    async refresh(record: AgentWorktreeRecord): Promise<WorktreeInspection | undefined> {
        if (record.state === "cleaned") return undefined;
        return this.worktrees.inspect(record);
    }

    async captureDiff(input: {
        record: AgentWorktreeRecord;
        inspection: WorktreeInspection;
        store: ToolResultStore;
        toolCallId: string;
    }): Promise<CapturedWorktreeDiff | undefined> {
        if (input.inspection.status !== "available" || !input.inspection.hasWork) {
            return undefined;
        }
        const diff = await this.worktrees.readDiff(input.record, input.inspection);
        return {
            stat: diff.stat,
            preview: diff.patch.length <= WORKTREE_DIFF_PREVIEW_CHARS
                ? diff.patch
                : `${diff.patch.slice(0, WORKTREE_DIFF_PREVIEW_CHARS)}\n…(完整 diff 请读取 Result ID)`,
            result: await input.store.persistText({
                toolCallId: input.toolCallId,
                toolName: "task",
                content: diff.patch,
                resultId: `worktree_${input.record.taskId}_${input.inspection.revision.slice(0, 12)}`,
            }),
        };
    }

    async discard(record: AgentWorktreeRecord) {
        return this.worktrees.discard(record);
    }

    load(taskId: string, sessionId: string) {
        return this.worktrees.load(taskId, sessionId);
    }

    async reconcileInterrupted(
        snapshot: AgentTaskSnapshot
    ): Promise<{worktree?: AgentTaskSnapshot["worktree"]; issue?: string}> {
        if (snapshot.worktree?.state !== "active") {
            return {worktree: snapshot.worktree};
        }
        try {
            const record = await this.worktrees.load(snapshot.id, snapshot.owner.sessionId);
            if (!record) return {issue: "找不到上次运行中 Agent 的 Worktree Manifest"};
            const lifecycle = await this.worktrees.finish(record);
            return {
                worktree: worktreeSnapshot(lifecycle.record, lifecycle.inspection),
            };
        } catch (error) {
            return {
                issue: `Worktree 恢复检查失败：${
                    error instanceof Error ? error.message : String(error)
                }`,
            };
        }
    }

    private async captureManagedDiff(
        task: ManagedAgentTask,
        inspection: AvailableWorktreeInspection
    ): Promise<void> {
        if (!task.worktree) return;
        try {
            const captured = await this.captureDiff({
                record: task.worktree,
                inspection,
                store: task.store,
                toolCallId: task.owner.toolCallId,
            });
            task.worktreeDiffStat = captured?.stat;
            task.worktreeDiffPreview = captured?.preview;
            task.worktreeDiffResult = captured?.result;
        } catch (error) {
            appendTaskIssue(
                task,
                `Worktree diff 生成失败：${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
