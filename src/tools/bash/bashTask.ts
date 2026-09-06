import {z} from "zod";
import type {Tool} from "../types.js";
import type {ShellTaskSnapshot} from "../../tasks/index.js";
import {checkTaskStopPermission} from "../task/stopPermission.js";

const inputSchema = z.object({
    task_id: z.string().describe("bash 返回的后台任务 ID"),
    action: z
        .enum(["status", "stop"])
        .default("status")
        .describe("status 查询状态和输出；stop 终止任务并返回最终状态"),
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

function formatSnapshot(snapshot: ShellTaskSnapshot): string {
    return [
        `Task: ${snapshot.id}`,
        `Status: ${snapshot.status}`,
        `Command: ${snapshot.command}`,
        `Cwd: ${snapshot.cwd}`,
        formatTermination(snapshot)
            ? `Termination: ${formatTermination(snapshot)}`
            : undefined,
        snapshot.output ? `Output:\n${snapshot.output}` : "Output: (无输出)",
        snapshot.outputResult
            ? `Result ID: ${snapshot.outputResult.resultId}`
            : undefined,
        snapshot.outputIssue
            ? `Output persistence warning: ${snapshot.outputIssue}`
            : undefined,
    ].filter(Boolean).join("\n");
}

export const bashTaskTool: Tool<typeof inputSchema> = {
    name: "bash_task",
    description: "查询或停止由 bash(run_in_background=true) 启动的受管理后台任务。",
    parameters: inputSchema,
    isReadOnly: ({action}) => action === "status",
    isConcurrencySafe: ({action}) => action === "status",
    checkPermissions: async ({action, task_id}, ctx) => action === "stop"
        ? checkTaskStopPermission(ctx, task_id, "shell")
        : {behavior: "passthrough"},
    async execute({task_id, action}, ctx) {
        if (!ctx.tasks) {
            return {content: "当前 Runtime 不支持后台 Bash 任务", outcome: "failed"};
        }
        const snapshot = action === "stop"
            ? await ctx.tasks.stop(task_id, "shell")
            : await ctx.tasks.get(task_id);
        if (!snapshot) {
            return {content: `后台任务不存在: ${task_id}`, outcome: "failed"};
        }
        if (snapshot.kind !== "shell") {
            return {
                content: `任务 ${task_id} 不是 Bash Task，请使用 task 工具。`,
                outcome: "failed",
            };
        }
        return {
            content: formatSnapshot(snapshot),
            outcome: snapshot.status === "failed" ? "failed" : "ok",
        };
    },
};
