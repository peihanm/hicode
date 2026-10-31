import {formatTaskHeader} from "../../tasks/format.js";
import {createAgentReceipt} from "./receipt.js";
import {z} from "zod";
import type {SubagentRegistry} from "../../subagents/registry.js";
import {hasAgentWriteTools,} from "../../subagents/registration.js";
import type {Tool} from "../types.js";
import {resolveSubagentDirectory} from "../../subagents/workspace.js";

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
        .describe("Registered role; Worker handles general implementation, Explore handles read-only investigation."),
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
    read_only: z.boolean().default(false).describe("Read-only investigation when true; prohibits writes and commands with side effects. Explore is always read-only."),
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
    registry: SubagentRegistry,
    fastModel?: string
): string {
    const agents = registry.listDefinitions().map((definition) => {
        const normalizedDescription = definition.whenToUse
            .replace(/\s+/g, " ")
            .trim();
        const description = normalizedDescription.length > 180
            ? `${normalizedDescription.slice(0, 179)}…`
            : normalizedDescription;
        const model = !(definition.source === "builtin" && definition.agentType === "Explore") ? "inherit parent model" : `fast (${fastModel ?? "configured fast model"})`;
        return boundedAgentLine(
            `- ${definition.agentType}: ${description} (tools: ${formatTools(definition.allowedTools)}; model: ${model})`
        );
    });
    return [
        "Delegate only a concrete independent subtask that can run alongside useful Root work, or a bounded investigation that materially reduces context noise. Complexity or many files alone do not justify delegation. Keep immediate blocking work local and do not duplicate delegated work.",
        "Choose a role and context independently: Worker for implementation, Explore for read-only investigation, or a registered specialist. fresh needs a complete briefing; inherit copies parent background with a worker system prompt. Assign disjoint file ownership, shared interfaces and module-level verification. Root runs full integration checks after dependencies are ready; workers report unfinished sibling dependencies instead of repeatedly checking or editing them. Preserve others' changes. read_only narrows access. cwd must already exist and be readable; actual writes require their own permissions.",
        "Every Agent starts asynchronously and returns a Task ID. Continue independent work; completion automatically delivers a notification with that ID, a summary and the saved report path. Use task wait with the exact task_id when its result blocks progress; wait_ms bounds only the wait and never stops the Agent. agent_message coordinates with an active child; agent_followup assigns more work on the same thread. interrupt ends the current run; stop closes the thread. Children cannot grant themselves permissions; an operation waiting for Host approval resumes automatically when approved, without followup. Read and integrate delegated results before the final answer; do not duplicate their work or poll repeatedly.",
        "Available agents:",
        ...agents,
    ].join("\n");
}

export function createAgentTool(
    registry: SubagentRegistry,
    fastModel?: string
): Tool<typeof agentInputSchema> {
    const writes = (input: z.infer<typeof agentInputSchema>): boolean => !input.read_only &&
        (!!registry.get(input.subagent_type) && hasAgentWriteTools(registry.get(input.subagent_type)!.definition));
    return {
        name: "agent",
        description: formatAgentToolDescription(registry, fastModel),
        getDescription: () => formatAgentToolDescription(registry, fastModel),
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
