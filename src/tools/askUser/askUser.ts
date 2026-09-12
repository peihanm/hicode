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
        .describe("2-4 options."),
}).strict();

const inputSchema = z.object({
    questions: z
        .array(questionSchema)
        .min(1)
        .max(4)
        .refine(questions => new Set(questions.map(item => item.question)).size === questions.length,
            "Question text must be unique within a batch")
        .describe("1-4 questions for the user."),
}).strict();

const answersSchema = z.record(z.string(), z.string().min(1).max(16_384)
    .refine(answer => answer.trim().length > 0, "Answer must not be empty"));

export const askUserTool: Tool<typeof inputSchema> = {
    name: "ask_user",
    description:
        "Ask the user to choose among options when a necessary decision cannot be resolved from available evidence. Submit 1-4 distinct questions, each with 2-4 options; write questions and options in the user's language. Do not invent answers or use this as a substitute for runtime permission requests. For a simple yes/no question, ask in ordinary text.",
    parameters: inputSchema,
    isReadOnly: () => true,
    requiresExplicitApproval: () => true,
    acceptsUserAnswers: true,
    // Declare ask intent to trigger the permission dialog flow.
    // App.tsx dispatches toolName === "ask_user" to AskDialog.
    async checkPermissions(input) {
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
    async execute(input, _ctx, invocation) {
        const parsed = answersSchema.safeParse(invocation.userAnswers);
        if (!parsed.success ||
            Object.keys(parsed.data).length !== input.questions.length ||
            input.questions.some(item => !Object.hasOwn(parsed.data, item.question))) {
            return {content: "Host did not provide a valid answer for every original question; approval is not a user answer.", outcome: "failed"};
        }
        const parts = input.questions.map(({question}) =>
            `${JSON.stringify(question)}=${JSON.stringify(parsed.data[question])}`);
        return `User answers: ${parts.join(", ")}`;
    },
};
