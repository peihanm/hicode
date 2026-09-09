import type {TaskSnapshot} from "../../tasks/index.js";
import type {SlashCommand} from "../types.js";

function formatTask(task: TaskSnapshot): string {
    if(task.kind==="memory")return `Task: ${task.id} · memory · ${task.status}\n${task.resultPreview??task.outputIssue??"正在提取与整理 Memory"}`;
    const result = task.outputResult?.resultId
        ? ` · result ${task.outputResult.resultId}`
        : "";
    if (task.kind === "shell") {
        return `- ${task.id} · shell · ${task.status}${result}\n  ${task.command}`;
    }
    const activity = task.progress.lastActivity
        ? ` · ${task.progress.lastActivity}`
        : "";
    const worktree = task.worktree
        ? `\n  worktree ${task.worktree.state} · ${task.worktree.changedFiles.length + (task.worktree.omittedChangedFiles ?? 0)} files · ${task.worktree.commitsAhead ?? 0} commits · ${task.worktree.path}${
            task.worktreeDiffResult
                ? `\n  diff result ${task.worktreeDiffResult.resultId}`
                : ""
        }`
        : "";
    const identity = task.agentName
        ? `${task.agentName} (${task.agentType})`
        : task.agentType;
    return `- ${task.id} · agent · ${task.status}${result}\n  ${identity} · ${task.description}\n  ${task.progress.iterations} iterations · ${task.progress.toolUseCount} tools${activity}${worktree}`;
}

export const tasksCommand: SlashCommand = {
    busyBehavior: "immediate",
    name: "tasks",
    description: "查看当前 Session 的后台任务",
    async execute(args, {ctx, onEvent, openTasks}) {
        if (args) {
            await onEvent({
                type: "assistant_text",
                content: "用法: /tasks",
            });
            return;
        }
        if (!ctx.tasks) {
            await onEvent({
                type: "assistant_text",
                content: "当前 Runtime 不支持后台任务。",
            });
            return;
        }
        if (openTasks) {openTasks(); return;}
        const tasks = await ctx.tasks.list();
        await onEvent({
            type: "assistant_text",
            content: tasks.length === 0
                ? "当前 Session 没有后台任务。"
                : `当前 Session 的后台任务：\n${tasks.map(formatTask).join("\n")}`,
        });
    },
};
