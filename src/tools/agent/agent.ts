import {z} from "zod";
import type {SubagentRegistry} from "../../subagents/registry.js";
import type {SubagentResult} from "../../subagents/types.js";
import {formatSubagentModel} from "../../subagents/model.js";
import {hasAgentWriteTools,} from "../../subagents/registration.js";
import type {Tool} from "../types.js";
import {resolveSubagentDirectory} from "../../subagents/workspace.js";

const agentInputSchema = z.object({
    description: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe("简短任务标签，用于界面和 transcript"),
    prompt: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .describe("给 fresh 子 Agent 的完整背景、范围、问题和期望输出"),
    subagent_type: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe("要启动的 Agent 类型；使用持久类型，或使用 fork 创建临时角色"),
    name: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .optional()
        .describe("subagent_type=fork 时必填的临时角色名，例如 frontend"),
    run_in_background: z
        .boolean()
        .default(false)
        .describe("true 时立即返回 Task ID，完成后 Pillar 主动通知"),
    cwd: z.string().trim().min(1).optional().describe("已有工作目录，默认当前目录；必须在父任务已授权目录内，不会自动创建或授权目录"),
    read_only: z.boolean().default(false).describe("true 时只读调查，禁止文件写入和有副作用的命令；Explore 始终只读"),
    model: z
        .enum(["inherit", "fast"])
        .optional()
        .describe("可选模型层级：inherit 使用主力模型；fast 使用独立配置的快速 Provider 与模型。仅持久 Agent 支持"),
}).strict();

const MAX_AGENT_TOOL_LINE_CHARS = 340;

function formatResult(result: SubagentResult): string {
    const completed =
        result.reason === "completed" || result.reason === "no_tool_calls";
    const label = result.agentType;
    if (completed) {
        return result.reply || `(${label} 已完成，但没有返回内容。)`;
    }
    return [
        `${label} 未完整完成（reason: ${result.reason}）。`,
        result.reply,
    ].join("\n\n");
}

function formatTools(tools: readonly string[]): string {
    if (tools.length <= 8) return tools.join(", ");
    return `${tools.slice(0, 8).join(", ")} 等 ${tools.length} 个`;
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
        const model = formatSubagentModel(
            definition.model,
            "继承父模型",
            fastModel
        );
        return boundedAgentLine(
            `- ${definition.agentType}: ${description} (tools: ${formatTools(definition.allowedTools)}; model: ${model})`
        );
    });
    return [
        "仅在委派有明确收益时启动子 Agent。Root 默认亲自完成顺序性的调查、实现和验证；任务复杂、跨多个文件或目录、耗时较长或需要多次工具调用本身都不是委派理由。只有子任务能与 Root 的其他有效工作并行，或大型陌生代码库的独立只读调查能显著压缩主上下文时才使用。若 Root 必须等待结果才能继续且自己具备所需工具，直接处理。",
        "Explore 用于独立只读调查。自定义 Agent 使用 fresh context，prompt 提供任务背景；fork 继承当前父对话，name 必填、后台运行、继承主模型。默认可修改文件和使用 Bash 验证，read_only=true 可收窄为只读。用 cwd 指定已有且获准的目录；不自动创建 Git Worktree、分支或集成改动。明确每个 Agent 的文件职责，保留其他工作者的修改。所有后台 Agent 可通过 task send 接收纠正或完成后沿原 History/cwd 继续，cancelled 和旧进程任务除外。需要新增目录、联网或 elevated 权限时，子 Agent 报告父 Agent 处理，不能自行越权。后台完成会主动通知，不要轮询等待。",
        "",
        "当前可用 Agent：",
        ...agents,
        "- fork: 继承父对话的临时 worker，可读取、搜索、修改文件并用 Bash 检查；read_only=true 时只提供读取与搜索工具。",
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
            return writes(input) ? {behavior: "ask", message: `启动可修改文件的子 Agent，工作目录：${input.cwd ?? ctx.cwd}`} : {behavior: "passthrough"};
        },
        requiresExplicitApproval: writes,
        async execute(input, ctx, invocation) {
            if (!ctx.subagentLauncher) return {content: "当前入口没有配置子 Agent launcher", outcome: "failed"};
            const workspaceWriteApproved = writes(input) &&
                (invocation.permissionApproved || (ctx.permissionMode === "full-access" && ctx.allowFullAccess));
            const common = {
                description: input.description, prompt: input.prompt,
                parentToolCallId: invocation.toolCallId,
                cwd: input.cwd, readOnly: input.read_only,
                ...(workspaceWriteApproved ? {workspaceWriteApproved: true as const} : {}),
            };
            if (input.subagent_type === "fork" && (!input.name || !input.run_in_background || input.model)) {
                return {content: "Fork 需要 name 和 run_in_background=true，继承父模型，不接受 model 参数。", outcome: "failed"};
            }
            if (input.subagent_type !== "fork" && !registry.has(input.subagent_type)) {
                return {content: `未知 Agent 类型: ${input.subagent_type}`, outcome: "failed"};
            }
            try {
                const launched = await ctx.subagentLauncher.launch(input.subagent_type === "fork"
                    ? {...common, kind: "fork", name: input.name!, runInBackground: true}
                    : {...common, kind: "registered", agentType: input.subagent_type,
                        runInBackground: input.run_in_background, ...(input.model ? {model: input.model} : {})});
                if (launched.kind === "foreground") return {content: formatResult(launched.result),
                    outcome: launched.result.reason === "completed" || launched.result.reason === "no_tool_calls" ? "ok" : "failed"};
                const task = launched.task;
                return {content: ["Agent Task 已启动。", `Task: ${task.id}`, `Agent: ${task.agentName ?? task.agentType}`,
                    `Description: ${task.description}`, `Status: ${task.status}`, `Cwd: ${task.cwd}`,
                    "完成后会主动通知；用 task send 纠正或继续原 Agent，不要轮询等待。"].join("\n"), outcome: "ok"};
            } catch (error) {return {content: error instanceof Error ? error.message : String(error), outcome: "failed"};}
        },
    };
}
