import type {TaskSnapshot} from "../../tasks/index.js";
import type {SlashCommand} from "../types.js";

function formatTask(task: TaskSnapshot): string {
    if(task.kind==="memory")return `Task: ${task.id} · memory · ${task.status}\n${task.resultPreview??task.outputIssue??"Extracting and consolidating Memory"}`;
    const result = task.outputResult?.resultId
        ? ` · result ${task.outputResult.resultId}`
        : "";
    if (task.kind === "shell") {
        return `- ${task.id} · shell · ${task.status}${result}\n  ${task.command}`;
    }
    const activity = task.progress.lastActivity
        ? ` · ${task.progress.lastActivity}`
        : "";
    const identity = task.agentName
        ? `${task.agentName} (${task.agentType})`
        : task.agentType;
    return `- ${task.id} · agent · ${task.status}${result}\n  ${identity} · ${task.description}\n  ${task.progress.iterations} iterations · ${task.progress.toolUseCount} tools${activity}`;
}

export const tasksCommand: SlashCommand = {
    busyBehavior: "immediate",
    name: "tasks",
    description: "View background tasks in this Session",
    async execute(args, {ctx, onEvent, openTasks}) {
        if (args) {
            await onEvent({
                type: "assistant_text",
                content: "Usage: /tasks",
            });
            return;
        }
        if (!ctx.tasks) {
            await onEvent({
                type: "assistant_text",
                content: "This Runtime does not support background tasks.",
            });
            return;
        }
        if (openTasks) {openTasks(); return;}
        const tasks = await ctx.tasks.list();
        await onEvent({
            type: "assistant_text",
            content: tasks.length === 0
                ? "This Session has no background tasks."
                : `Background tasks in this Session:\n ${tasks.map(formatTask).join("\n")}`,
        });
    },
};
