import {zodToJsonSchema} from "zod-to-json-schema";
import {z} from "zod";
import type {AgentTaskSnapshot, ShellTaskSnapshot, TaskSnapshot} from "../../tasks/index.js";
import type {Tool} from "../types.js";
import {checkTaskStopPermission} from "./stopPermission.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../agent/inputChannel.js";
import {agentRunTiming} from "../../tasks/timing.js";
import {waitForAgentActivity} from "../../tasks/agentJoin.js";

const inputSchema = z.object({
    action: z
        .enum(["list", "status", "wait", "interrupt", "stop"])
        .default("list")
        .describe("Manage tasks. wait awaits any pending delegated Agent or incoming message without polling; interrupt retains the Agent thread; stop closes it."),
    task_id: z
        .string()
        .optional()
        .describe("Required except for list and wait. wait defaults to pending delegates; an explicit Agent ID is included alongside them."),
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
        `Task: ${task.id}`,
        "Type: agent",
        `Cwd: ${task.cwd}`,
        `Status: ${task.status}`,
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
        "Manage this session's background Shell/Agent tasks with list/status/wait/interrupt/stop. Use wait when an Agent result blocks further work; omit task_id to wait for any pending delegate. Completion, coordination messages or user input wake the wait; no periodic timeout. Complete integration before your final answer. Avoid repeated status polling. Use agent_followup to assign additional work to an existing Agent. Use agent_message for ordinary coordination without waking an idle thread. interrupt cancels only the current Agent run and retains its thread; agent_followup can continue it. stop closes the Agent permanently for this session. A status result is current evidence; historical notifications are not proof of a live process. Stop only managed tasks within the authorized scope.",
    parameters: inputSchema,
    isReadOnly: ({action}) => action === "list" || action === "status" || action === "wait",
    isConcurrencySafe: ({action}) => action === "list" || action === "status",
    checkPermissions: async ({action, task_id}, ctx) => {
        if (action === "stop" || action === "interrupt") return checkTaskStopPermission(ctx, task_id);
        return {behavior: "passthrough"};
    },
    async execute({action, task_id}, ctx) {
        if (!ctx.tasks) {
            return {content: "This Runtime does not support background tasks", outcome: "failed"};
        }
        if (action === "list") {
            const tasks = await ctx.tasks.list();
            return tasks.length === 0
                ? "This Session has no background tasks."
                : tasks.map(formatTask).join("\n\n");
        }
        if (action === "wait") {
            if (!("subscribe" in ctx.tasks)) return {content: "Agent waiting is available only to the parent", outcome: "denied"};
            const ids = [...new Set([...(ctx.agentJoin?.ids ?? []), ...(task_id ? [task_id] : [])])];
            if (!ids.length) return "No delegated Agent results are pending.";
            const initial = await Promise.all(ids.map(id => ctx.tasks!.get(id)));
            if (initial.some(task => !task || task.kind !== "agent")) return {content: "Cannot wait for an unavailable Agent task", outcome: "failed"};
            await waitForAgentActivity(ctx.tasks, ids, ctx.signal,
                signal => ctx.agentMessaging ? ctx.agentMessaging.wait(signal) : EMPTY_AGENT_INPUT_CHANNEL.waitForInput(signal));
            const snapshots = await Promise.all(ids.map(id => ctx.tasks!.get(id)));
            const completed = snapshots.filter((task): task is AgentTaskSnapshot => task?.kind === "agent" && task.status !== "running");
            for (const task of completed) ctx.agentJoin?.markReported(task);
            return {
                content: completed.length ? completed.map(formatTask).join("\n\n")
                    : "New input is available and will be delivered after this tool batch. Delegated agents may still be running.",
                outcome: completed.some(task => task.status === "failed") ? "failed" : "ok",
            };
        }
        if (!task_id) return {content: `${action} requires task_id`, outcome: "failed"};
        if (action === "interrupt" && !(action in ctx.tasks)) return {content: "Child Agents can manage only their own Shell tasks", outcome: "denied"};
        if (action === "interrupt" && "interrupt" in ctx.tasks) {
            try {return {content: formatTask(await ctx.tasks.interrupt(task_id)), outcome: "ok"};}
            catch (error) {return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};}
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

/** Keep the parent's permission/execution handlers, but expose only child-owned Shell actions. */
export function childTaskTool(parent: Tool): Tool {
    const parameters = inputSchema.extend({action: z.enum(["list", "status", "stop"]).default("list")}).strict();
    return {...parent,
        parameters: parent.parameters.and(parameters),
        inputJsonSchema: zodToJsonSchema(parameters, {target: "jsonSchema7"}),
        getDescription: undefined,
        description: "List, inspect or stop only background Shell tasks started by this child. Other agents' tasks are inaccessible. For new assignments or blockers, message the parent instead. Permission checks still apply.",
    };
}
