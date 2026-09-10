import {z} from "zod";
import type {Tool} from "../types.js";

// 问题由模型提供，答案只能由当前 Host interaction 经 invocation 提供。
const questionSchema = z.object({
    question: z.string().trim().min(1).describe("要问用户的问题，同批问题文本必须唯一"),
    options: z
        .array(
            z.object({
                label: z.string().trim().min(1).max(16_384).describe("选项显示文本"),
                description: z.string().optional().describe("选项说明"),
            }).strict()
        )
        .min(2)
        .max(4)
        .describe("2-4 个选项"),
}).strict();

const inputSchema = z.object({
    questions: z
        .array(questionSchema)
        .min(1)
        .max(4)
        .refine(questions => new Set(questions.map(item => item.question)).size === questions.length,
            "同批问题文本不能重复")
        .describe("要问用户的问题列表（1-4 个）"),
}).strict();

const answersSchema = z.record(z.string(), z.string().min(1).max(16_384)
    .refine(answer => answer.trim().length > 0, "答案不能为空"));

export const askUserTool: Tool<typeof inputSchema> = {
    name: "ask_user",
    description:
        "向用户提出多选题。可以一次问 1-4 个问题，每个问题 2-4 个选项。当需要用户从多个选项中做决策时使用（如选技术方案、选文件路径）。不要用来问 yes/no（那个直接在回复里问）。",
    parameters: inputSchema,
    isReadOnly: () => true,
    requiresExplicitApproval: () => true,
    acceptsUserAnswers: true,
    // 声明权限意向：需要问用户（触发权限弹窗流程）
    // App.tsx 根据 toolName === "ask_user" 分发到 AskDialog
    async checkPermissions(input) {
        // 用第一个问题作弹窗消息（AskDialog 会渲染所有问题）
        const first = input.questions[0];
        const count = input.questions.length;
        return {
            behavior: "ask",
            message:
                count > 1
                    ? `有 ${count} 个问题需要你回答，第一个：${first.question}`
                    : first.question,
        };
    },
    async execute(input, _ctx, invocation) {
        const parsed = answersSchema.safeParse(invocation.userAnswers);
        if (!parsed.success ||
            Object.keys(parsed.data).length !== input.questions.length ||
            input.questions.some(item => !Object.hasOwn(parsed.data, item.question))) {
            return {content: "Host 未提供与原问题逐一对应的有效答案，不能将批准视为用户回答。", outcome: "failed"};
        }
        const parts = input.questions.map(({question}) =>
            `${JSON.stringify(question)}=${JSON.stringify(parsed.data[question])}`);
        return `用户回答: ${parts.join(", ")}`;
    },
};
