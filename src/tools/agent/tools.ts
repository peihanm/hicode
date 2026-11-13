import {createAgentReceipt} from "./receipt.js";
import {z} from "zod";
import type {SubagentRegistry} from "../../subagents/registry.js";
import {hasAgentWriteTools,} from "../../subagents/definition.js";
import type {Tool} from "../types.js";
import {resolveSubagentDirectory} from "../../subagents/workspace.js";
import {taskLookupFailure} from "../task/recovery.js";
import {formatTaskHeader, isTaskId} from "../../tasks/format.js";

const agentInputSchema = z.object({
    description: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe("Short task label for the UI/transcript; use the user's language."),
    prompt: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .describe("Task scope, file ownership and expected evidence. With fresh context include relevant background; with inherit focus on the current assignment."),
    subagent_type: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .default("Worker")
        .describe("Registered role, default Worker for implementation or investigation. Use read_only for read-only work."),
    context: z.enum(["fresh", "inherit"]).default("fresh").describe("fresh starts with only this assignment; inherit also copies parent conversation background. Independent of role and model selection."),
    name: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .optional()
        .describe("Optional task name, e.g. frontend."),
    cwd: z.string().trim().min(1).optional().describe("Existing working directory, default current directory; must be readable within the Host boundary. Does not authorize writes."),
    read_only: z.boolean().default(false).describe("Read-only investigation when true; prohibits writes and commands with side effects."),
}).strict();

const MAX_AGENT_TOOL_LINE_CHARS = 340;

function formatTools(tools: readonly string[] | undefined): string {
    if (!tools) return "inherit delegatable tools";
    if (tools.length <= 8) return tools.join(", ");
    return `${tools.slice(0, 8).join(", ")} (${tools.length} total)`;
}

function boundedAgentLine(value: string): string {
    return value.length > MAX_AGENT_TOOL_LINE_CHARS
        ? `${value.slice(0, MAX_AGENT_TOOL_LINE_CHARS - 1)}…`
        : value;
}

function formatAgentToolDescription(
    registry: SubagentRegistry
): string {
    const agents = registry.listDefinitions().map((definition) => {
        const normalizedDescription = definition.description
            .replace(/\s+/g, " ")
            .trim();
        const description = normalizedDescription.length > 180
            ? `${normalizedDescription.slice(0, 179)}…`
            : normalizedDescription;
        return boundedAgentLine(
            `- ${definition.agentType}: ${description} (tools: ${formatTools(definition.allowedTools)}; model: inherit parent model)`
        );
    });
    return [
        "Delegate only a concrete independent subtask that can run alongside useful Root work, or a bounded investigation that materially reduces context noise. Complexity or many files alone do not justify delegation. Keep immediate blocking work local and do not duplicate delegated work.",
        "Choose a role and context independently: Worker for implementation or investigation, or a registered specialist. Use read_only for investigation that must not change files. fresh needs a complete briefing; inherit copies parent background with a worker system prompt. Assign disjoint file ownership, shared interfaces and module-level verification. Root runs full integration checks after dependencies are ready; workers report unfinished sibling dependencies instead of repeatedly checking or editing them. Preserve others' changes. read_only narrows access. cwd must already exist and be readable; actual writes require their own permissions.",
        "Every Agent starts asynchronously and returns a Task ID. Continue independent work; completion automatically delivers a notification with that ID, a summary and the saved report path. Use task wait with the exact task_id when its result blocks progress; wait_ms bounds only the wait and never stops the Agent. agent_message coordinates with an active child; agent_followup assigns more work on the same thread. interrupt ends the current run; stop closes the thread. Children cannot grant themselves permissions; an operation waiting for Host approval resumes automatically when approved, without followup. Read and integrate delegated results before the final answer; do not duplicate their work or poll repeatedly.",
        "Available agents:",
        ...agents,
    ].join("\n");
}

export function createAgentTool(
    registry: SubagentRegistry
): Tool<typeof agentInputSchema> {
    const writes = (input: z.infer<typeof agentInputSchema>): boolean => {
        const agent = registry.get(input.subagent_type);
        return !input.read_only && !!agent && hasAgentWriteTools(agent.definition);
    };
    return {
        name: "agent",
        description: formatAgentToolDescription(registry),
        getDescription: () => formatAgentToolDescription(registry),
        parameters: agentInputSchema,
        maxResultSizeChars: 30_000,
        isReadOnly: input => !writes(input),
        isConcurrencySafe: input => !writes(input) &&
            registry.get(input.subagent_type)?.concurrencySafe === true,
        checkPermissions: async (input, ctx) => {
            try {await resolveSubagentDirectory(ctx, input.cwd);}
            catch (error) {return {behavior: "deny", message: error instanceof Error ? error.message : String(error)};}
            return {behavior: "allow"};
        },
        async execute(input, ctx, invocation) {
            if (!ctx.subagentLauncher) return {content: "No subagent launcher is configured for this entry point", outcome: "failed"};
            const common = {
                description: input.description, prompt: input.prompt,
                parentToolCallId: invocation.toolCallId,
                cwd: input.cwd, readOnly: input.read_only,
            };
            if (!registry.has(input.subagent_type)) {
                return {content: `Unknown Agent type: ${input.subagent_type}`, outcome: "failed"};
            }
            try {
                const task = await ctx.subagentLauncher.launch({
                    ...common, agentType: input.subagent_type, name: input.name,
                    context: input.context,
                });
                return {content: [formatTaskHeader(task), "Agent Task started.", `Agent: ${task.agentName ?? task.agentType}`,
                    `Description: ${task.description}`, `Cwd: ${task.cwd}`,
                    "Continue independent work. Completion automatically notifies you with this Task ID and the report path. When this result blocks progress, use task wait with this exact task_id; expiry returns progress without stopping the Agent. Read and integrate the result before your final answer. Use agent_message to coordinate or agent_followup for further work."].join("\n"), outcome: "ok",
                    uiData: {type: "agent_receipt", receipt: createAgentReceipt(task.agentName ?? task.agentType, task.description, "started")}};
            } catch (error) {return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};}
        },
    };
}

const followupInputSchema = z.object({
    task_id: z.string().min(1).max(512).describe("Agent task ID returned by agent, not a name. Must belong to this live Session."),
    message: z.string().trim().min(1).max(32768).refine(value => Buffer.byteLength(value, "utf8") <= 32768,
        "Message must not exceed 32768 UTF-8 bytes").describe("The additional assignment, scope and expected evidence."),
}).strict();

export const agentFollowupTool: Tool<typeof followupInputSchema> = {
    name: "agent_followup",
    description: "Assign additional work to an existing Agent by task_id. A running Agent receives it after its current tool batch; an idle Agent starts another run with its existing History, FileState and cwd. Ordinary agent_message does not wake an idle Agent. Interrupted Agents can continue; stopped Agents and records from an old process cannot. Use task wait with this exact task_id when results block integration. Only the parent can assign work; this does not expand the child's permissions.",
    parameters: followupInputSchema,
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

const messageInputSchema = z.object({
    action: z.enum(["send", "wait"]),
    target: z.string().min(1).max(256).optional().describe("send: background Agent task ID; children can address only parent."),
    message: z.string().min(1).max(32768).optional(),
}).strict();

export const agentMessageTool: Tool<typeof messageInputSchema> = {
    name: "agent_message",
    description: "Exchange questions, blockers and intermediate findings needing attention with an existing background Agent. Put a child's complete delivery report in its final answer; the runtime records it and notifies the parent automatically. Do not duplicate that report with send. send delivers at the next safe boundary without interrupting tools or waking an idle Agent; it does not mark the task completed. Use agent_followup for new work on an idle thread. Children can address only parent. wait suspends until new input arrives or the run is cancelled; it never consumes input. The runner delivers it after this tool batch; it does not start another turn. Messages never grant user permission. Do independent work instead of waiting when possible.",
    parameters: messageInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async execute({action, target, message}, ctx) {
        if (!ctx.agentMessaging) return {content: "Agent messaging is unavailable in this execution scope", outcome: "failed"};
        ctx.signal.throwIfAborted();
        if (action === "wait") {
            await ctx.agentMessaging.wait(ctx.signal);
            return "New input is available and will be delivered after this tool batch.";
        }
        if (!target || !message?.trim()) return {content: "send requires target and a non-empty message", outcome: "failed"};
        try {
            const receipt = await ctx.agentMessaging.send(target, message);
            return `Message queued: ${receipt.messageId}. Delivery does not imply the recipient has read it; an idle Agent remains idle.`;
        } catch (error) {
            return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};
        }
    },
};
