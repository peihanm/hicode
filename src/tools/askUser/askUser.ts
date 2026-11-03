import {formatUserAnswers} from "../../runtime/userQuestions.js";
import {z} from "zod";
import type {Tool} from "../types.js";

// The model provides questions; only the current Host interaction supplies answers through invocation.
const questionSchema = z.object({
    question: z.string().trim().min(1).describe("Question for the user; question text must be unique within this batch."),
    options: z
        .array(
            z.object({
                label: z.string().trim().min(1).max(16_384).describe("User-facing option label."),
                description: z.string().optional().describe("Option explanation."),
            }).strict()
        )
        .min(2)
        .max(4)
        .optional()
        .describe("2-4 choices; omit for a free-text question."),
    multi_select: z.boolean().optional().describe("Allow multiple choices. Requires options."),
}).strict().refine(q => !q.multi_select || q.options !== undefined, "multi_select requires options")
    .refine(q => !q.options || new Set(q.options.map(option => option.label)).size === q.options.length, "Option labels must be unique");

const inputSchema = z.object({
    delivery: z.enum(["sync", "async"]).default("sync").describe("sync waits for answers. async returns immediately; answers arrive later as user input. Continue only independent work; silence is never approval."),
    questions: z
        .array(questionSchema)
        .min(1)
        .max(4)
        .refine(questions => new Set(questions.map(item => item.question)).size === questions.length,
            "Question text must be unique within a batch")
        .describe("1-4 questions for the user."),
}).strict();

export const askUserTool: Tool<typeof inputSchema> = {
    name: "ask_user",
    description:
        "Ask necessary questions that available evidence cannot resolve. Submit 1-4 distinct questions. Omit options for free text, provide 2-4 options for single choice, or set multi_select for multiple choices. Use delivery=sync when the answer blocks progress; async lets independent work continue and delivers answers later. Unanswered questions grant no authorization; write questions and options in the user's language. Do not invent answers or use this as a substitute for runtime permission requests. For a simple yes/no question, ask in ordinary text.",
    parameters: inputSchema,
    isReadOnly: () => true,
    requiresExplicitApproval: () => true,
    acceptsUserAnswers: true,
    // Declare ask intent to trigger the permission dialog flow.
    // App.tsx dispatches toolName === "ask_user" to AskDialog.
    async checkPermissions(input, ctx) {
        if (input.delivery === "async") return ctx.userQuestions && ctx.permissionPromptPolicy === "onRequest"
            ? {behavior: "allow"}
            : {behavior: "deny", message: "This Host does not support asynchronous questions"};
        // Use the first question as the dialog message; AskDialog renders all questions.
        const first = input.questions[0];
        const count = input.questions.length;
        return {
            behavior: "ask",
            message:
                count > 1
                    ? `There are ${count} questions to answer. First: ${first.question}`
                    : first.question,
        };
    },
    async execute(input, ctx, invocation) {
        if (input.delivery === "async") {
            if (!ctx.userQuestions) return {content: "Asynchronous questions unavailable", outcome: "failed"};
            const requestId = ctx.userQuestions.ask(input, invocation.toolCallId);
            return `Question request ${requestId} is pending in this live Session (not restored after closing). Answers will arrive as user input. Continue independent work only; do not assume an answer or approval.`;
        }
        const content = formatUserAnswers(input.questions, invocation.userAnswers);
        return content ?? {content: "Host did not provide a valid answer for every original question; approval is not a user answer.", outcome: "failed"};
    },
};
