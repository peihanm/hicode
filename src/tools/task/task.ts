import {shellResultUI} from "../bash/receipt.js";
import {agentRunTiming, formatTaskHeader, formatTaskSummary, isTaskId} from "../../tasks/format.js";
import {taskLookupFailure} from "./recovery.js";
import {zodToJsonSchema} from "zod-to-json-schema";
import {z} from "zod";
import type {ShellTaskSnapshot, TaskSnapshot} from "../../tasks/index.js";
import type {Tool} from "../types.js";
import {checkTaskStopPermission} from "./stopPermission.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../agent/inputChannel.js";
import {DEFAULT_TASK_WAIT_MS, MAX_TASK_WAIT_MS, waitForTaskActivity} from "../../tasks/wait.js";
import {isParentTaskSession} from "../../tasks/session.js";
import {taskNotificationId} from "../../tasks/notifications.js";

const inputSchema = z.object({
    action: z
        .enum(["list", "status", "wait", "interrupt", "stop"])
        .default("list")
        .describe("Manage tasks. wait awaits only the explicit Shell or Agent task without polling; interrupt retains the Agent thread; stop closes it."),
    task_id: z
        .string()
        .optional()
        .describe("Required except for list. wait watches only this Shell or Agent task; it never collects sibling results."),
    wait_ms: z.number().int().min(1).max(MAX_TASK_WAIT_MS).optional()
        .describe("Only for wait with an explicit Shell or Agent task_id. Single wait window in milliseconds, default 30000, maximum 300000; expiry returns running status without stopping the task. Start with 10-30s for searches/checks; use longer windows for progressing builds/training. This is not a total execution timeout."),
}).strict();

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
    if (task.kind === "review") return `${formatTaskHeader(task)}
Advisory review of rounds ${task.fromRound}-${task.toRound}; do not wait for this task.
${task.resultPreview ?? task.outputIssue ?? "Reviewing frozen evidence"}`;
    if(task.kind==="memory")return `${formatTaskHeader(task)}\n${task.resultPreview??task.outputIssue??"Extracting and consolidating Memory"}`;
    const result = task.outputResult
        ? `\nSaved output: ${JSON.stringify(task.outputResult.path)}`
        : "";
    const issue = task.outputIssue ? `\nIssue: ${task.outputIssue}` : "";
    if (task.kind === "shell") {
        const termination = formatTermination(task);
        return [
            formatTaskHeader(task),
            `phase: ${task.phase}${task.phase === "queued" ? " (process not started)" : ""}`,
            `Process started: ${task.processStartedAt ?? "no"}`,
            `Queued: ${task.timing.queuedMs} ms; running: ${task.timing.runningMs} ms`,
            `Command: ${task.command}`,
            `Cwd: ${task.cwd}`,
            ...(termination ? [`Termination: ${termination}`] : []),
            task.output ? `Output:\n${task.output}` : "Output: (no output)",
        ].join("\n") + result + issue;
    }
    const timing = agentRunTiming(task);
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
        formatTaskHeader(task),
        `Cwd: ${task.cwd}`,
        `Agent: ${task.agentName ? `${task.agentName} (${task.agentType})` : task.agentType}`,
        `Description: ${task.description}`,
        `Progress: ${progress}`,
        `Run time: ${Math.floor(timing.runMs / 1000)}s · Total execution: ${Math.floor(timing.totalMs / 1000)}s`,
        `Todos this run: ${task.progress.todosUpdated ? "updated" : "not updated"}${!task.progress.todosUpdated && task.progress.todos?.length ? "; unfinished plan carried forward" : ""}`,
        task.progress.lastActivity
            ? `Last activity: ${task.progress.lastActivity}`
            : undefined,
        task.reason ? `Reason: ${task.reason}` : undefined,
        task.progress.todos?.length ? `Tasks:\n${task.progress.todos.map(todo => `- ${todo.status}: ${todo.content}`).join("\n")}` : undefined,
        task.resultPreview ? `Result preview:\n${task.resultPreview}` : undefined,
        task.transcriptPath ? `Transcript: ${task.transcriptPath}` : undefined,
    ].filter(Boolean).join("\n") + result + issue;
}

export const taskTool: Tool<typeof inputSchema> = {
    name: "task",
    description:
        "Manage this session's Shell/Agent tasks with list/status/wait/interrupt/stop. Every action except list requires an explicit task_id. wait watches only that task and returns at completion, incoming input, or wait_ms expiry (default 30000, maximum 300000). Expiry or cancelling a wait does not stop the task or declare failure. Keep the same ID to wait again or continue independent work; completion automatically notifies you. Shell waits include new output; Agent waits include current progress and saved results. Read and integrate delegated results before your final answer; avoid repeated status polling. agent_followup assigns more work on the same Agent thread; agent_message coordinates without waking an idle thread. interrupt ends an Agent's current run; stop closes it. Only manage tasks within the authorized Session.",
    parameters: inputSchema,
    isReadOnly: ({action}) => action === "list" || action === "status" || action === "wait",
    isConcurrencySafe: ({action}) => action === "list" || action === "status",
    checkPermissions: async ({action, task_id}, ctx) => {
        if (action === "stop" || action === "interrupt") return checkTaskStopPermission(ctx, task_id);
        return {behavior: "passthrough"};
    },
    async execute({action, task_id, wait_ms}, ctx) {
        if (!ctx.tasks) {
            return {content: "This Runtime does not support background tasks", outcome: "failed"};
        }
        if (wait_ms !== undefined && (action !== "wait" || !task_id)) return {content: "wait_ms requires wait with an explicit task_id", outcome: "failed"};
        if (action === "list") {
            const tasks = await ctx.tasks.list();
            return tasks.length === 0
                ? "This Session has no background tasks."
                : tasks.map(formatTaskSummary).join("\n\n");
        }
        if (task_id !== undefined && !isTaskId(task_id)) return {content: await taskLookupFailure(ctx, task_id, action), outcome: "failed"};
        if (action === "wait") {
            if (!task_id) return {content: "task wait requires an explicit task_id. Use task list to find the task, then wait for that ID.", outcome: "failed"};
            const target = await ctx.tasks.get(task_id);
            if (!target) return {content: await taskLookupFailure(ctx, task_id, action), outcome: "failed"};
            if (target.kind === "memory") return {content: "Memory tasks do not support wait; use status.", outcome: "failed"};
            if (target.kind === "review") return {content: "Task reviews are advisory; continue the main task without waiting. Use status for diagnostics.", outcome: "failed"};
            if (target.kind === "agent" && !isParentTaskSession(ctx.tasks)) return {content: "Children can wait only for their own Shell tasks.", outcome: "denied"};
            const baseline = target.kind === "shell" && target.status === "running"
                ? await ctx.tasks.readShellOutput(task_id, 0) : undefined;
            const started = performance.now();
            const windowMs = wait_ms ?? DEFAULT_TASK_WAIT_MS;
            const wake = await waitForTaskActivity(ctx.tasks, [task_id], ctx.signal, target.kind,
                signal => ctx.agentMessaging ? ctx.agentMessaging.wait(signal) : EMPTY_AGENT_INPUT_CHANNEL.waitForInput(signal),
                windowMs);
            const completed = await ctx.tasks.get(task_id);
            if (!completed || completed.kind !== target.kind) return {content: "The waited task became unavailable", outcome: "failed"};
            let content = formatTask(completed);
            if (completed.status === "running") {
                if (completed.kind === "shell") {
                    const chunk = await ctx.tasks.readShellOutput(task_id, baseline?.nextOffset ?? 0);
                    content = formatTask({...completed, output: chunk
                        ? `New output during this wait:\n${chunk.content || "(no new output)"}`
                        : "Live capture is no longer available; inspect task status for completion."});
                }
                content += `\nWaited: ${Math.round(performance.now() - started)} ms (window: ${windowMs} ms).`;
                content += wake === "input"
                    ? "\nNew input is available and will be delivered after this tool batch. The specified task is still running."
                    : "\nWait window elapsed; the task is still running, not failed or stopped. Continue waiting with the same task_id, do independent work, or use stop if appropriate.";
            }
            if (completed.kind === "agent") {
                ctx.taskJoin?.markReported(completed);
                return {content, outcome: completed.status === "failed" || completed.outputIssue ? "failed" : "ok"};
            }
            return {content, ...shellResultUI(completed.termination, !!completed.outputIssue),
                ...(completed.status !== "running" ? {completedTask: {taskId: completed.id, notificationId: taskNotificationId(completed.id, 1)}} : {}),
                outcome: completed.outputIssue && completed.termination?.kind === "exit" && completed.termination.code === 0
                    ? "output_failed" : completed.status === "failed" || completed.outputIssue ? "failed" : "ok"};
        }

        if (!task_id) return {content: await taskLookupFailure(ctx, task_id, action), outcome: "failed"};
        const target = await ctx.tasks.get(task_id);
        if (!target) return {content: await taskLookupFailure(ctx, task_id, action), outcome: "failed"};
        if (action === "interrupt" && target.kind !== "agent") return {content: `${formatTaskHeader(target)}\ninterrupt only applies to Agent runs. Use stop to terminate this task.`, outcome: "failed"};
        if (action === "interrupt" && !(action in ctx.tasks)) return {content: "Child Agents can manage only their own Shell tasks", outcome: "denied"};
        if (action === "interrupt" && "interrupt" in ctx.tasks) {
            try {return {content: formatTask(await ctx.tasks.interrupt(task_id)), outcome: "ok"};}
            catch (error) {return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};}
        }
        const task = action === "stop"
            ? await ctx.tasks.stop(task_id)
            : await ctx.tasks.get(task_id);
        if (!task) {
            return {content: await taskLookupFailure(ctx, task_id, action), outcome: "failed"};
        }
        if (action === "stop") {
            const operation = target.kind !== "agent" && target.status !== "running"
                ? "Task already finished; no stop needed."
                : "Task stopped.";
            return {content: `${operation}\n${formatTask(task)}`, outcome: "ok",
                ...(task.kind === "shell" ? shellResultUI(task.termination, !!task.outputIssue) : {})};
        }
        return {
            content: formatTask(task),
            ...(task.kind === "shell" ? shellResultUI(task.termination, !!task.outputIssue) : {}),
            outcome: task.status === "failed" ? "failed" : "ok",
        };
    },
};

/** Keep the parent's permission/execution handlers, but expose only child-owned Shell actions. */
export function childTaskTool(parent: Tool): Tool {
    const parameters = inputSchema.extend({action: z.enum(["list", "status", "wait", "stop"]).default("list")}).strict();
    return {...parent,
        parameters: parent.parameters.and(parameters),
        inputJsonSchema: zodToJsonSchema(parameters, {target: "jsonSchema7"}),
        getDescription: undefined,
        description: "List, inspect, wait for or stop only background Shell tasks started by this child. wait requires their task_id; wait_ms defaults to 30000 and is capped at 300000. Completion returns termination/output; window expiry returns running status and new output during this wait, without restarting or stopping the process. Adjust the next window to progress; reconsider silent broad searches without assuming every quiet job has stalled. Other agents' tasks are inaccessible. For new assignments or blockers, message the parent instead. Permission checks still apply.",
    };
}
