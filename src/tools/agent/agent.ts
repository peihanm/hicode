import {z} from "zod";
import type {AgentTaskSnapshot} from "../../tasks/index.js";
import type {SubagentRegistry} from "../../subagents/registry.js";
import type {SubagentResult} from "../../subagents/types.js";
import {formatSubagentModel} from "../../subagents/model.js";
import {hasAgentWriteTools, validateBackgroundAgent,} from "../../subagents/registration.js";
import type {Tool} from "../types.js";

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
    isolation: z
        .enum(["worktree"])
        .optional()
        .describe("写型自定义 Agent 后台运行时必须使用 worktree 隔离"),
    model: z
        .enum(["inherit", "fast"])
        .optional()
        .describe("可选模型层级：inherit 使用主力模型；fast 使用独立配置的快速 Provider 与模型。仅持久 Agent 支持"),
});

const MAX_AGENT_TOOL_LINE_CHARS = 340;

function worktreeLaunchLines(task: AgentTaskSnapshot): string[] {
    if (!task.worktree) return [];
    return [
        `Worktree: ${task.worktree.path}`,
        `Base: ${task.worktree.baseCommit}`,
        ...(task.worktree.sourceHadChanges
            ? ["注意：来源工作区有未提交修改，这些内容未进入 Worktree。"]
            : []),
    ];
}
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
        "Explore 用于独立的大范围只读调查或多个可并行研究方向。GeneralPurpose 默认不自动使用；只有用户明确要求委派，或边界清楚的独立实现确实需要 fresh context 隔离时才使用。它是前台串行 Agent，不用于承接整个已批准计划，也不能声称与 Root 并行。持久 Agent 使用 fresh context，prompt 必须提供完整背景；model=fast 适合边界明确、低风险的只读调查，复杂实现和独立验证使用主力模型。subagent_type=fork 会继承当前父对话，name 必填且必须后台运行，不接受 model。只读 Fork 可并行调查，写 Fork 必须 isolation=worktree。仅使用安全结构化文件工具的写型自定义 Agent 可使用 Worktree。后台普通 Agent 可通过 task action=send 接收中途修正或在完成后沿用同一 History 继续；cancelled、Worktree 和旧进程恢复出的 Agent 不支持。后台完成后 Pillar 会主动通知，禁止轮询等待。Worktree 是协作隔离，不是 OS 沙盒。不要在主上下文重复执行已经委派的调查；工具结果对用户不可见，完成后必须由你总结。",
        "",
        "当前可用 Agent：",
        ...agents,
        "- fork: 根据当前父对话临时派生具名 worker，不会保存为 Agent 定义 (readonly tools: list_files, read_file, grep, read_tool_result; worktree tools: list_files, read_file, grep, edit_file, write_file, delete_file, read_tool_result)",
    ].join("\n");
}

export function createAgentTool(
    registry: SubagentRegistry,
    fastModel?: string
): Tool<typeof agentInputSchema> {
    return {
        name: "agent",
        description: formatAgentToolDescription(registry, fastModel),
        getDescription: () => formatAgentToolDescription(registry, fastModel),
        parameters: agentInputSchema,
        maxResultSizeChars: 30_000,
        isReadOnly: ({subagent_type, isolation}) => {
            if (subagent_type === "fork") return isolation !== "worktree";
            const definition = registry.get(subagent_type)?.definition;
            return isolation !== "worktree" &&
                (!definition || !hasAgentWriteTools(definition));
        },
        isConcurrencySafe: ({subagent_type, isolation}) =>
            isolation !== "worktree" && (
                subagent_type === "fork" ||
                registry.get(subagent_type)?.concurrencySafe === true
            ),
        checkPermissions: async ({subagent_type, isolation}) => {
            if (subagent_type === "fork") {
                return isolation === "worktree"
                    ? {behavior: "ask", message: "启动可修改文件的临时 Worktree Fork"}
                    : {behavior: "passthrough"};
            }
            const definition = registry.get(subagent_type)?.definition;
            if (
                isolation === "worktree" ||
                (definition ? hasAgentWriteTools(definition) : false)
            ) {
                return {
                    behavior: "ask",
                    message: isolation === "worktree"
                        ? "启动可修改文件的 Worktree Agent"
                        : "启动可修改当前工作区的子 Agent",
                };
            }
            return {behavior: "passthrough"};
        },
        requiresUserInteraction: ({subagent_type, isolation}) => {
            if (subagent_type === "fork") return isolation === "worktree";
            const definition = registry.get(subagent_type)?.definition;
            return isolation === "worktree" ||
                (definition ? hasAgentWriteTools(definition) : false);
        },
        async execute(input, ctx, invocation) {
            if (!ctx.subagentLauncher) {
                return {
                    content: "当前运行入口没有配置子 Agent launcher",
                    outcome: "failed",
                };
            }
            if (input.subagent_type === "fork") {
                if (input.model) {
                    return {
                        content: "Fork Agent 继承父模型，不接受 model 参数。",
                        outcome: "failed",
                    };
                }
                if (!input.name) {
                    return {
                        content: "subagent_type=fork 时必须提供 name。",
                        outcome: "failed",
                    };
                }
                if (!input.run_in_background) {
                    return {
                        content: "Fork Agent 必须设置 run_in_background=true。",
                        outcome: "failed",
                    };
                }
                try {
                    const launched = await ctx.subagentLauncher.launch({
                        kind: "fork",
                        name: input.name,
                        description: input.description,
                        prompt: input.prompt,
                        parentToolCallId: invocation.toolCallId,
                        runInBackground: true,
                        ...(input.isolation ? {isolation: input.isolation} : {}),
                    });
                    const task = launched.kind === "background"
                        ? launched.task
                        : undefined;
                    if (!task) {
                        return {content: "Fork 未进入后台 Task。", outcome: "failed"};
                    }
                    return {
                        content: [
                            "Fork Agent Task 已启动。",
                            `Task: ${task.id}`,
                            `Agent: ${input.name} (fork)`,
                            `Description: ${task.description}`,
                            `Status: ${task.status}`,
                            ...worktreeLaunchLines(task),
                            "完成后 Pillar 会主动通知；不要轮询等待。",
                        ].filter(Boolean).join("\n"),
                        outcome: "ok",
                    };
                } catch (error) {
                    return {
                        content: error instanceof Error ? error.message : String(error),
                        outcome: "failed",
                    };
                }
            }
            const registration = registry.get(input.subagent_type);
            if (!registration) {
                const available = registry
                    .listDefinitions()
                    .map((definition) => definition.agentType)
                    .join(", ");
                return {
                    content: `未知 Agent 类型: ${input.subagent_type}。当前可用: ${available}`,
                    outcome: "failed",
                };
            }
            const request = {
                agentType: registration.definition.agentType,
                description: input.description,
                prompt: input.prompt,
                parentToolCallId: invocation.toolCallId,
            };
            if (input.isolation && !input.run_in_background) {
                return {
                    content: "isolation=worktree 第一版只支持后台 Agent。",
                    outcome: "failed",
                };
            }
            if (input.run_in_background) {
                const policyIssue = validateBackgroundAgent(
                    registration.definition,
                    input.isolation
                );
                if (policyIssue) {
                    return {
                        content: policyIssue,
                        outcome: "failed",
                    };
                }
                if (!ctx.tasks) {
                    return {
                        content: "当前运行入口不支持后台 Agent Task。",
                        outcome: "failed",
                    };
                }
                const launched = await ctx.subagentLauncher.launch({
                    kind: "registered",
                    agentType: request.agentType,
                    description: request.description,
                    prompt: request.prompt,
                    parentToolCallId: request.parentToolCallId,
                    ...(input.model ? {model: input.model} : {}),
                    runInBackground: true,
                    ...(input.isolation ? {isolation: input.isolation} : {}),
                });
                if (launched.kind !== "background") {
                    return {content: "Agent 未进入后台 Task。", outcome: "failed"};
                }
                const task = launched.task;
                return {
                    content: [
                        "Agent Task 已启动。",
                        `Task: ${task.id}`,
                        `Agent: ${task.agentType}`,
                        `Description: ${task.description}`,
                        `Status: ${task.status}`,
                        ...worktreeLaunchLines(task),
                        "完成后 Pillar 会主动通知；不要轮询等待。",
                    ].filter(Boolean).join("\n"),
                    outcome: "ok",
                };
            }
            const launched = await ctx.subagentLauncher.launch({
                kind: "registered",
                agentType: request.agentType,
                description: request.description,
                prompt: request.prompt,
                parentToolCallId: request.parentToolCallId,
                ...(input.model ? {model: input.model} : {}),
                runInBackground: false,
            });
            if (launched.kind !== "foreground") {
                return {content: "Agent 意外进入后台 Task。", outcome: "failed"};
            }
            const result = launched.result;
            return {
                content: formatResult(result),
                outcome:
                    result.reason === "interrupted"
                        ? "interrupted"
                        : result.reason === "max_turns" ||
                            result.reason === "permission_denied"
                          ? "failed"
                          : "ok",
            };
        },
    };
}
