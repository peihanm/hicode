import {resolveSubagentDirectory} from "../../subagents/workspace.js";
import {taskLookupFailure} from "../task/recovery.js";
import {formatTaskHeader, isTaskId} from "../../tasks/format.js";
import {createAgentReceipt} from "../agent/receipt.js";
import {z} from "zod";
import type {Tool} from "../types.js";

const inputSchema = z.object({
    task_id: z.string().min(1).max(512).describe("Agent task ID returned by agent, not a name. Must belong to this live Session."),
    message: z.string().trim().min(1).max(32768).refine(value => Buffer.byteLength(value, "utf8") <= 32768,
        "Message must not exceed 32768 UTF-8 bytes").describe("The additional assignment, scope and expected evidence."),
}).strict();

export const agentFollowupTool: Tool<typeof inputSchema> = {
    name: "agent_followup",
    description: "Assign additional work to an existing Agent by task_id. A running Agent receives it after its current tool batch; an idle Agent starts another run with its existing History, FileState and cwd. Ordinary agent_message does not wake an idle Agent. Interrupted Agents can continue; stopped Agents and records from an old process cannot. Use task wait with this exact task_id when results block integration. Only the parent can assign work; this does not expand the child's permissions.",
    parameters: inputSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async checkPermissions({task_id}, ctx) {
        if (!ctx.tasks || !("followup" in ctx.tasks)) {
            return {behavior: "deny", message: "Agent follow-up is available only to the parent"};
        }
        if (!isTaskId(task_id)) return {behavior: "deny", message: await taskLookupFailure(ctx, task_id, "agent_followup")};
        const task = await ctx.tasks.get(task_id);
        if (!task) return {behavior: "deny", message: await taskLookupFailure(ctx, task_id, "agent_followup")};
        if (task.kind !== "agent") {
            return {behavior: "deny", message: "The target must be an Agent in this Session"};
        }
        try {await resolveSubagentDirectory(ctx, task.cwd);}
        catch (error) {return {behavior: "deny", message: String(error)};}
        return {behavior: "allow"};
    },
    async execute({task_id, message}, ctx) {
        if (!ctx.tasks || !("followup" in ctx.tasks)) {
            return {content: "Agent follow-up is available only to the parent", outcome: "denied"};
        }
        ctx.signal.throwIfAborted();
        try {
            const {task, delivery} = await ctx.tasks.followup(task_id, message);
            ctx.taskJoin?.register(task);
            const queued = delivery === "queued";
            return {content: [
                formatTaskHeader(task),
                `${queued ? "Assignment queued" : "Agent continued"}: ${task.agentName ?? task.agentType}`,
                `Run: ${task.progress.runCount}`,
                queued ? "Delivery occurs at a safe boundary; this receipt is not a completion report."
                    : "A new run uses the existing Agent context; this receipt is not a completion report.",
                "Continue independent work, then use task wait with this exact task_id to collect results and integrate.",
            ].join("\n"), outcome: "ok",
                uiData: {type: "agent_receipt", receipt: createAgentReceipt(task.agentName ?? task.agentType, task.description, queued ? "queued" : "continued")}};
        } catch (error) {
            return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};
        }
    },
};
