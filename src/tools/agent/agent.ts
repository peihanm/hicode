import {z} from "zod";
import type {SubagentRegistry} from "../../subagents/registry.js";
import type {SubagentResult} from "../../subagents/types.js";
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
    run_in_background: z
        .boolean()
        .default(false)
        .describe("Return a Task ID immediately when true; HiCode notifies completion."),
    cwd: z.string().trim().min(1).optional().describe("Existing working directory, default current directory; must be within parent-authorized directories. Does not create or authorize a directory."),
    read_only: z.boolean().default(false).describe("Read-only investigation when true; prohibits writes and commands with side effects. Explore is always read-only."),
    model: z
        .enum(["inherit", "fast"])
        .optional()
        .describe("Optional model tier: inherit uses the parent target; fast uses the configured fast provider/model. Available for every role and context mode."),
}).strict();

const MAX_AGENT_TOOL_LINE_CHARS = 340;

function formatResult(result: SubagentResult): string {
    const completed =
        result.reason === "completed" || result.reason === "no_tool_calls";
    const label = result.agentType;
    if (completed) {
        return [result.reply || `(${label} completed but returned no content.)`, result.transcriptIssue].filter(Boolean).join("\n\n");
    }
    return [
        `${label} did not fully complete (reason: ${result.reason}).`,
        result.reply,
    ].join("\n\n");
}

function formatTools(tools: readonly string[]): string {
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
        const model = definition.model === "inherit" ? "inherit parent model" : `fast (${fastModel ?? "configured fast model"})`;
        return boundedAgentLine(
            `- ${definition.agentType}: ${description} (tools: ${formatTools(definition.allowedTools)}; model: ${model})`
        );
    });
    return [
        "Delegate only a concrete independent subtask that can run alongside useful Root work, or a bounded investigation that materially reduces context noise. Complexity or many files alone do not justify delegation. Keep immediate blocking work local and do not duplicate delegated work.",
        "Choose a role and context independently: Worker for implementation, Explore for read-only investigation, or a registered specialist. fresh needs a complete briefing; inherit copies parent background with a worker system prompt. Assign disjoint file ownership and preserve others' changes. read_only narrows access. cwd must already exist and be authorized; directory creation and integration use ordinary tools.",
        "Use run_in_background=true for parallel work and two-way agent_message communication. task followup assigns new work to a running or finished thread with its History/cwd; interrupt ends only its current run; stop closes it. Cancelled tasks and tasks from an old process cannot continue. Children report missing directory, network or elevated access to Root; they cannot expand permissions. Completion is notified automatically; avoid polling.",
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
            return writes(input) ? {behavior: "ask", message: `Start an Agent with file-write access in: ${input.cwd ?? ctx.cwd}`} : {behavior: "passthrough"};
        },
        requiresExplicitApproval: writes,
        async execute(input, ctx, invocation) {
            if (!ctx.subagentLauncher) return {content: "No subagent launcher is configured for this entry point", outcome: "failed"};
            const workspaceWriteApproved = writes(input) &&
                (invocation.permissionApproved || (ctx.permissionMode === "full-access" && ctx.allowFullAccess));
            const common = {
                description: input.description, prompt: input.prompt,
                parentToolCallId: invocation.toolCallId,
                cwd: input.cwd, readOnly: input.read_only,
                ...(workspaceWriteApproved ? {workspaceWriteApproved: true as const} : {}),
            };
            if (!registry.has(input.subagent_type)) {
                return {content: `Unknown Agent type: ${input.subagent_type}`, outcome: "failed"};
            }
            try {
                const launched = await ctx.subagentLauncher.launch({
                    ...common, agentType: input.subagent_type, name: input.name,
                    context: input.context, runInBackground: input.run_in_background,
                    ...(input.model ? {model: input.model} : {}),
                });
                if (launched.kind === "foreground") return {content: formatResult(launched.result),
                    outcome: launched.result.reason === "completed" || launched.result.reason === "no_tool_calls" ? "ok" : "failed"};
                const task = launched.task;
                return {content: ["Agent Task started.", `Task: ${task.id}`, `Agent: ${task.agentName ?? task.agentType}`,
                    `Description: ${task.description}`, `Status: ${task.status}`, `Cwd: ${task.cwd}`,
                    "Completion will be notified automatically; use agent_message for coordination or task followup for additional work. Do not poll."].join("\n"), outcome: "ok"};
            } catch (error) {return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};}
        },
    };
}
