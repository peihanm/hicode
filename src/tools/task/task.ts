import {z} from "zod";
import type {ShellTaskSnapshot, TaskSnapshot} from "../../tasks/index.js";
import type {Tool} from "../types.js";
import {checkTaskStopPermission} from "./stopPermission.js";

const inputSchema = z.object({
    action: z
        .enum(["list", "status", "followup", "interrupt", "stop"])
        .default("list")
        .describe("Manage tasks. followup assigns work; interrupt retains the Agent thread; stop closes it."),
    task_id: z
        .string()
        .optional()
        .describe("Required except for list; returned by background bash or agent."),
    message: z
        .string()
        .min(1)
        .max(32 * 1024)
        .optional()
        .describe("Required for followup: inject at a safe boundary while running, or continue the same finished Agent thread."),
});

function formatTermination(snapshot: ShellTaskSnapshot): string | undefined {
    const termination = snapshot.termination;
    if (!termination) return undefined;
    if (termination.kind === "exit") {
        return termination.signal
            ? `signal ${termination.signal}`
            : `exit code ${termination.code}`;
    }
    if (termination.kind === "timeout") return `timeout ${termination.timeoutMs}ms`;
    if (termination.kind === "aborted") return `aborted ${termination.reason}`;
    if (termination.kind === "output_limit") {
        return `output limit ${termination.maxBuffer} bytes`;
    }
    return `spawn error: ${termination.error.message}`;
}

function formatTask(task: TaskSnapshot): string {
    if(task.kind==="memory")return `Task: ${task.id} · memory · ${task.status}\n${task.resultPreview??task.outputIssue??"Extracting and consolidating Memory"}`;
    const result = task.outputResult
        ? `\nSaved output: ${JSON.stringify(task.outputResult.path)}`
        : "";
    const issue = task.outputIssue ? `\nIssue: ${task.outputIssue}` : "";
    if (task.kind === "shell") {
        const termination = formatTermination(task);
        return [
            `Task: ${task.id}`,
            "Type: shell",
            `Status: ${task.status}`,
            `Command: ${task.command}`,
            `Cwd: ${task.cwd}`,
            ...(termination ? [`Termination: ${termination}`] : []),
            task.output ? `Output:\n${task.output}` : "Output: (no output)",
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
    return [
        `Task: ${task.id}`,
        "Type: agent",
        `Cwd: ${task.cwd}`,
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
    ].filter(Boolean).join("\n") + result + issue;
}

export const taskTool: Tool<typeof inputSchema> = {
    name: "task",
    description:
        "Manage this session's background Shell/Agent tasks with list/status/followup/interrupt/stop. Completion is notified automatically; avoid repeated polling. followup steers a running Agent at a safe boundary or continues a finished thread. Use agent_message for ordinary coordination without waking an idle thread. interrupt cancels only the current Agent run and retains its thread; followup can continue it. stop closes the Agent permanently for this session. A status result is current evidence; historical notifications are not proof of a live process. Stop only managed tasks within the authorized scope.",
    parameters: inputSchema,
    isReadOnly: ({action}) => action === "list" || action === "status",
    isConcurrencySafe: ({action}) => action === "list" || action === "status",
    checkPermissions: async ({action, task_id}, ctx) => {
        if (action === "stop" || action === "interrupt") return checkTaskStopPermission(ctx, task_id);
        return {behavior: "passthrough"};
    },
    async execute({action, task_id, message}, ctx) {
        if (!ctx.tasks) {
            return {content: "This Runtime does not support background tasks", outcome: "failed"};
        }
        if (action === "list") {
            const tasks = await ctx.tasks.list();
            return tasks.length === 0
                ? "This Session has no background tasks."
                : tasks.map(formatTask).join("\n\n");
        }
        if (!task_id) {
            return {
                content: `${action} requires task_id`,
                outcome: "failed",
            };
        }
        if (action === "interrupt") {
            try {return {content: formatTask(await ctx.tasks.interrupt(task_id)), outcome: "ok"};}
            catch (error) {return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};}
        }
        if (action === "followup") {
            if (!message?.trim()) {
                return {
                    content: "followup requires a non-empty message",
                    outcome: "failed",
                };
            }
            try {
                const task = await ctx.tasks.followup(task_id, message);
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
            : await ctx.tasks.get(task_id);
        if (!task) {
            return {content: `Background task not found: ${task_id}`, outcome: "failed"};
        }
        return {
            content: formatTask(task),
            outcome: task.status === "failed" ? "failed" : "ok",
        };
    },
};
