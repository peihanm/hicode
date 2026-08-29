import {z} from "zod";
import type {Tool, ToolContext} from "../types.js";
import type {PermissionResult} from "../../permissions/index.js";

const inputSchema = z.object({
    plan: z
        .string()
        .min(1)
        .describe("准备交给用户批准的执行计划。应具体说明要改哪些模块、关键步骤和验证方式。"),
});

type Input = z.infer<typeof inputSchema>;

const MAX_CONFIRM_PLAN_CHARS = 4000;

function formatPlanForConfirm(plan: string): string {
    const trimmed = plan.trim();
    if (trimmed.length <= MAX_CONFIRM_PLAN_CHARS) return trimmed;
    return `${trimmed.slice(0, MAX_CONFIRM_PLAN_CHARS)}\n\n... (计划过长，已截断显示)`;
}

export const exitPlanModeTool: Tool<typeof inputSchema> = {
    name: "exit_plan_mode",
    description: [
        "提交执行计划给用户批准，并在批准后退出 Plan 模式。",
        "",
        "只能在 Plan 模式下使用。不要在文本里问用户计划是否可以；当计划准备好时调用本工具。",
        "用户批准后，你可以开始编码；如果任务有多步，先用 todo_write 更新执行清单。",
    ].join("\n"),
    parameters: inputSchema,

    isReadOnly: () => false,
    requiresUserInteraction: () => true,

    async checkPermissions(input: Input, ctx: ToolContext): Promise<PermissionResult> {
        if (ctx.permissionMode !== "plan") {
            return {
                behavior: "deny",
                message: "exit_plan_mode 只能在 Plan 模式下使用",
            };
        }

        const plan = input.plan.trim();
        if (!plan) {
            return {
                behavior: "deny",
                message: "exit_plan_mode 需要提供非空计划",
            };
        }

        return {
            behavior: "ask",
            message: [
                "是否批准这个计划并开始执行？",
                "",
                formatPlanForConfirm(plan),
            ].join("\n"),
        };
    },

    async execute({plan}: Input, _ctx: ToolContext): Promise<string> {
        const approvedPlan = plan.trim();

        return [
            "用户已批准计划。现在可以开始实现。",
            "如果任务包含多个步骤，先用 todo_write 更新清单。",
            "",
            "## Approved Plan",
            approvedPlan,
        ].join("\n");
    },
};
