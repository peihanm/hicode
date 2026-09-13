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
        .describe("Self-contained background, scope, question and expected output for the child; Fork also receives parent history."),
    subagent_type: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe("Registered Agent type, or fork for a temporary role."),
    name: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .optional()
        .describe("Temporary role name required for subagent_type=fork, e.g. frontend."),
    run_in_background: z
        .boolean()
        .default(false)
        .describe("Return a Task ID immediately when true; Pillar notifies completion."),
    cwd: z.string().trim().min(1).optional().describe("Existing working directory, default current directory; must be within parent-authorized directories. Does not create or authorize a directory."),
    read_only: z.boolean().default(false).describe("Read-only investigation when true; prohibits writes and commands with side effects. Explore is always read-only."),
    model: z
        .enum(["inherit", "fast"])
        .optional()
        .describe("Optional model tier: inherit uses the parent target; fast uses the configured fast provider/model. Registered Agents only."),
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
        "Explore is read-only. Registered agents start fresh: provide background, scope and expected evidence. fork inherits conversation background but has a worker system prompt, requires name, runs in background and inherits the parent model. Assign disjoint file ownership and preserve others' changes. read_only narrows write/command access. cwd must already exist and be authorized; it does not create worktrees/branches or integrate changes.",
        "Use task send to steer running agents or continue finished threads with their History/cwd, except cancelled tasks or tasks from an old process. Children report missing directory, network or elevated access to Root; they cannot expand permissions. Completion is notified automatically; avoid polling.",
        "Available agents:",
        ...agents,
        "- fork: temporary worker with parent context; can read, search, edit and run bash checks within scope. read_only=true restricts it to reading/search.",
    ].join("\n");
}

export function createAgentTool(
    registry: SubagentRegistry,
    fastModel?: string
): Tool<typeof agentInputSchema> {
    const writes = (input: z.infer<typeof agentInputSchema>): boolean => !input.read_only &&
        (input.subagent_type === "fork" || !!registry.get(input.subagent_type) && hasAgentWriteTools(registry.get(input.subagent_type)!.definition));
    return {
        name: "agent",
        description: formatAgentToolDescription(registry, fastModel),
        getDescription: () => formatAgentToolDescription(registry, fastModel),
        parameters: agentInputSchema,
        maxResultSizeChars: 30_000,
        isReadOnly: input => !writes(input),
        isConcurrencySafe: input => !writes(input) &&
            (input.subagent_type === "fork" || registry.get(input.subagent_type)?.concurrencySafe === true),
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
            if (input.subagent_type === "fork" && (!input.name || !input.run_in_background || input.model)) {
                return {content: "Fork requires name and run_in_background=true, inherits the parent model and does not accept model.", outcome: "failed"};
            }
            if (input.subagent_type !== "fork" && !registry.has(input.subagent_type)) {
                return {content: `Unknown Agent type: ${input.subagent_type}`, outcome: "failed"};
            }
            try {
                const launched = await ctx.subagentLauncher.launch(input.subagent_type === "fork"
                    ? {...common, kind: "fork", name: input.name!, runInBackground: true}
                    : {...common, kind: "registered", agentType: input.subagent_type,
                        runInBackground: input.run_in_background, ...(input.model ? {model: input.model} : {})});
                if (launched.kind === "foreground") return {content: formatResult(launched.result),
                    outcome: launched.result.reason === "completed" || launched.result.reason === "no_tool_calls" ? "ok" : "failed"};
                const task = launched.task;
                return {content: ["Agent Task started.", `Task: ${task.id}`, `Agent: ${task.agentName ?? task.agentType}`,
                    `Description: ${task.description}`, `Status: ${task.status}`, `Cwd: ${task.cwd}`,
                    "Completion will be notified automatically; use task send to steer or continue the Agent. Do not poll."].join("\n"), outcome: "ok"};
            } catch (error) {return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};}
        },
    };
}
