import {z} from "zod";
import type {Tool, ToolContext} from "../types.js";
import type {PermissionResult} from "../../permissions/index.js";

const inputSchema = z.object({
    reason: z
        .string()
        .optional()
        .describe("为什么需要进入 Plan 模式。简短说明即可；用户明确要求规划时可以省略。"),
});

type Input = z.infer<typeof inputSchema>;

export const enterPlanModeTool: Tool<typeof inputSchema> = {
    name: "enter_plan_mode",
    description: [
        "进入 Plan 模式，用于非平凡实现任务开始前的只读探索和方案设计。",
        "",
        "使用时机：用户要求实现较复杂功能、跨多个模块修改、架构不确定、或需要先调查再动手。",
        "进入后只能探索、阅读、搜索、询问澄清问题和设计方案；不要写入或修改文件。",
        "当方案准备好后，调用 exit_plan_mode 并提供具体计划，等待用户批准后再开始编码。",
        "",
        "不要用于简单问答、单文件小修或用户已经明确要求立即执行的低风险任务。纯代码库研究和架构解释直接调查，不要为了研究本身进入 Plan。",
    ].join("\n"),
    parameters: inputSchema,

    isReadOnly: () => true,
    requiresUserInteraction: () => true,

    async checkPermissions(input: Input, ctx: ToolContext): Promise<PermissionResult> {
        if (ctx.collaborationMode === "plan") {
            return {behavior: "allow"};
        }

        const reason = input.reason?.trim();
        return {
            behavior: "ask",
            message: [
                "是否进入 Plan 模式？",
                reason ? `原因: ${reason}` : undefined,
                "Plan 模式下会先只读探索和制定方案，获得批准后再编码。",
            ]
                .filter(Boolean)
                .join("\n"),
        };
    },

    async execute(_input: Input, ctx: ToolContext): Promise<string> {
        ctx.setCollaborationMode("plan");

        return "已进入 Plan 模式：先了解项目并整理方案，确认后再开始修改。";
    },
};
