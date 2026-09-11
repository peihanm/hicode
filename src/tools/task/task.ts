import {z} from "zod";
import type {ShellTaskSnapshot, TaskSnapshot} from "../../tasks/index.js";
import type {Tool} from "../types.js";
import {checkTaskStopPermission} from "./stopPermission.js";

const inputSchema = z.object({
    action: z
        .enum(["list", "status", "send", "stop"])
        .default("list")
        .describe("list/status/send/stop 管理任务；send 向 Agent 发送消息或继续"),
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
    if(task.kind==="memory")return `Task: ${task.id} · memory · ${task.status}\n${task.resultPreview??task.outputIssue??"正在提取与整理 Memory"}`;
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
        "管理当前 Session 的后台 Shell/Agent Task。Pillar 会主动通知完成结果，不要连续轮询。",
    parameters: inputSchema,
    isReadOnly: ({action}) => action === "list" || action === "status",
    isConcurrencySafe: ({action}) => action === "list" || action === "status",
    checkPermissions: async ({action, task_id}, ctx) => {
        if (action === "stop") return checkTaskStopPermission(ctx, task_id);
        return {behavior: "passthrough"};
    },
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
