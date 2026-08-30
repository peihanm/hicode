import {z} from "zod";
import type {TaskSnapshot} from "../../tasks/index.js";
import type {Tool} from "../types.js";

const inputSchema = z.object({
    action: z
        .enum(["list", "status", "send", "stop", "discard"])
        .default("list")
        .describe("list/status/send/stop 管理任务；send 向 Agent 发送消息或继续；discard 永久删除已结束的 Worktree"),
    task_id: z
        .string()
        .optional()
        .describe("除 list 外必填；由后台 bash 或 Agent Tool 返回"),
    message: z
        .string()
        .min(1)
        .max(32 * 1024)
        .optional()
        .describe("action=send 时必填；运行中在安全边界注入，已结束时继续同一 Agent Thread"),
});

function formatTask(task: TaskSnapshot): string {
    const result = task.outputResult
        ? `\nResult ID: ${task.outputResult.resultId}`
        : "";
    const issue = task.outputIssue ? `\nIssue: ${task.outputIssue}` : "";
    if (task.kind === "shell") {
        return [
            `Task: ${task.id}`,
            "Type: shell",
            `Status: ${task.status}`,
            `Command: ${task.command}`,
            task.output ? `Output:\n${task.output}` : "Output: (无输出)",
        ].join("\n") + result + issue;
    }
    const progress = [
        `run ${task.progress.runCount}`,
        `${task.progress.iterations} iterations`,
        `${task.progress.toolUseCount} tools`,
        task.progress.pendingMessages > 0
            ? `${task.progress.pendingMessages} queued messages`
            : undefined,
        task.progress.tokenCount !== undefined
            ? `${task.progress.tokenCount} tokens`
            : undefined,
    ].filter(Boolean).join(" · ");
    const worktree = task.worktree
        ? [
            `Worktree: ${task.worktree.path}`,
            `Worktree state: ${task.worktree.state}`,
            `Branch: ${task.worktree.branch}`,
            `Base: ${task.worktree.baseCommit}`,
            task.worktree.sourceHadChanges
                ? "Source checkout: had uncommitted changes (not included in this Worktree)"
                : "Source checkout: clean when this Worktree was created",
            task.worktree.headCommit ? `HEAD: ${task.worktree.headCommit}` : undefined,
            task.worktree.dirty !== undefined ? `Dirty: ${task.worktree.dirty}` : undefined,
            task.worktree.commitsAhead !== undefined
                ? `Commits ahead of base: ${task.worktree.commitsAhead}`
                : undefined,
            task.worktree.changedFiles.length > 0
                ? `Changed files:\n${task.worktree.changedFiles.map(
                    (file) => `- ${file.kind}: ${file.originalPath ? `${file.originalPath} -> ` : ""}${file.path}`
                ).join("\n")}${task.worktree.omittedChangedFiles
                    ? `\n- … ${task.worktree.omittedChangedFiles} more file(s) omitted from summary`
                    : ""}`
                : "Changed files: (无)",
            task.worktree.cleanupReason
                ? `Cleanup: ${task.worktree.cleanupReason}`
                : undefined,
            task.worktree.issue ? `Worktree issue: ${task.worktree.issue}` : undefined,
            task.worktreeDiffStat ? `Diff stat:\n${task.worktreeDiffStat}` : undefined,
            task.worktreeDiffPreview ? `Diff preview:\n${task.worktreeDiffPreview}` : undefined,
            task.worktreeDiffResult
                ? `Diff Result ID: ${task.worktreeDiffResult.resultId}`
                : undefined,
            task.worktree.state === "changed"
                ? [
                    "Next: inspect and test this Worktree, commit selected files there,",
                    `then cherry-pick the commit into the source checkout and run task discard task_id=${task.id}.`,
                    "Git integration is not captured by Pillar File Checkpoints; /rewind cannot promise to undo it.",
                ].join(" ")
                : undefined,
        ].filter(Boolean)
        : [];
    return [
        `Task: ${task.id}`,
        "Type: agent",
        `Status: ${task.status}`,
        `Agent: ${task.agentName ? `${task.agentName} (${task.agentType})` : task.agentType}`,
        `Description: ${task.description}`,
        `Progress: ${progress}`,
        task.progress.lastActivity
            ? `Last activity: ${task.progress.lastActivity}`
            : undefined,
        task.reason ? `Reason: ${task.reason}` : undefined,
        task.resultPreview ? `Result preview:\n${task.resultPreview}` : undefined,
        task.transcriptPath ? `Transcript: ${task.transcriptPath}` : undefined,
        ...worktree,
    ].filter(Boolean).join("\n") + result + issue;
}

export const taskTool: Tool<typeof inputSchema> = {
    name: "task",
    description:
        "管理当前 Session 的后台 Shell/Agent Task。Pillar 会主动通知完成结果，不要连续轮询。",
    parameters: inputSchema,
    isReadOnly: ({action}) => action === "list" || action === "status",
    isConcurrencySafe: ({action}) => action === "list" || action === "status",
    checkPermissions: async ({action}) => {
        if (action === "discard") {
            return {behavior: "ask", message: "永久丢弃 Worktree 及其未应用变更"};
        }
        return {behavior: "passthrough"};
    },
    requiresUserInteraction: ({action}) => action === "discard",
    async execute({action, task_id, message}, ctx) {
        if (!ctx.tasks) {
            return {content: "当前 Runtime 不支持后台任务", outcome: "failed"};
        }
        if (action === "list") {
            const tasks = await ctx.tasks.list();
            return tasks.length === 0
                ? "当前 Session 没有后台任务。"
                : tasks.map(formatTask).join("\n\n");
        }
        if (!task_id) {
            return {
                content: `${action} 需要 task_id`,
                outcome: "failed",
            };
        }
        if (action === "send") {
            if (!message?.trim()) {
                return {
                    content: "send 需要非空 message",
                    outcome: "failed",
                };
            }
            try {
                const task = await ctx.tasks.send(task_id, message);
                return {
                    content: formatTask(task),
                    outcome: "ok",
                };
            } catch (error) {
                return {
                    content: error instanceof Error
                        ? error.message
                        : String(error),
                    outcome: "failed",
                };
            }
        }
        const task = action === "stop"
            ? await ctx.tasks.stop(task_id)
            : action === "discard"
                    ? await ctx.tasks.discardWorktree(task_id)
                    : await ctx.tasks.get(task_id);
        if (!task) {
            return {content: `后台任务不存在: ${task_id}`, outcome: "failed"};
        }
        return {
            content: formatTask(task),
            outcome: task.status === "failed" ? "failed" : "ok",
        };
    },
};
