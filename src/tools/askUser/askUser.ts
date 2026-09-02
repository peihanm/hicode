import {z} from "zod";
import type {Tool} from "../types.js";

// askUser 工具：让 LLM 主动向用户提多选题
//
// 设计参考 claude-code src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx
// 关键：复用权限流程，不另开通道
//   1. checkPermissions 返回 { behavior: "ask" }
//   2. UI 层根据 toolName 分发到 AskDialog（而非 ConfirmDialog）
//   3. 用户回答后，AskDialog 通过 PermissionDecision.updatedInput 回流 answers
//   4. executeTool 用 updatedInput 替换 input，tool.execute 拿到带 answers 的 input
//
// 简化点（相对 claude-code）：
//   - 不支持 multiSelect（所有问题都是单选）
//   - 不支持 preview / annotations
//   - 不支持 metadata

// 单个问题的 schema
const questionSchema = z.object({
    question: z.string().describe("要问用户的问题"),
    options: z
        .array(
            z.object({
                label: z.string().describe("选项显示文本"),
                description: z.string().optional().describe("选项说明"),
            })
        )
        .min(2)
        .max(4)
        .describe("2-4 个选项"),
    // answer 由 UI 层注入（用户选择后），LLM 不需要填
    answer: z.string().optional().describe("用户选择的 label（UI 注入，LLM 不填）"),
});

const inputSchema = z.object({
    // 支持 1-4 个问题：LLM 可以一次问多个问题减少往返
    // 参考 claude-code AskUserQuestionTool schema: questions.min(1).max(4)
    questions: z
        .array(questionSchema)
        .min(1)
        .max(4)
        .describe("要问用户的问题列表（1-4 个）"),
    // answers 由 UI 层注入：Record<question_text, answer>
    // 用 question 文本作 key（跟 claude-code 一致）
    answers: z
        .record(z.string(), z.string())
        .optional()
        .describe("用户回答（UI 注入，LLM 不填）"),
});

export const askUserTool: Tool<typeof inputSchema> = {
    name: "ask_user",
    description:
        "向用户提出多选题。可以一次问 1-4 个问题，每个问题 2-4 个选项。当需要用户从多个选项中做决策时使用（如选技术方案、选文件路径）。不要用来问 yes/no（那个直接在回复里问）。",
    parameters: inputSchema,
    isReadOnly: () => true,
    requiresUserInteraction: () => true,
    acceptsUpdatedInputFromUser: true,
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
    // execute 时 input 已经带 answers 字段（由 AskDialog 通过 updatedInput 注入）
    async execute(input) {
        const answers = input.answers ?? {};
        const parts = Object.entries(answers).map(
            ([q, a]) => `"${q}"="${a}"`
        );
        if (parts.length === 0) return "用户未回答任何问题";
        return `用户回答: ${parts.join(", ")}`;
    },
};
