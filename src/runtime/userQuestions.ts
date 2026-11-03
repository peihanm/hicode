export interface UserQuestion {
    question: string;
    options?: {label: string; description?: string}[];
    multi_select?: boolean;
}
export interface UserQuestionInput {
    questions: UserQuestion[];
    delivery: "sync" | "async";
}
export type UserAnswers = Record<string, string | string[]>;

export function validUserAnswer(value: unknown): value is string | string[] {
    const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 16_384;
    return text(value) || (Array.isArray(value) && value.length > 0 && value.length <= 5 &&
        value.every(text) && new Set(value).size === value.length);
}

export function formatUserAnswers(questions: readonly UserQuestion[], value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const answers = Object.entries(value);
    if (answers.length !== questions.length) return undefined;
    const parts: string[] = [];
    for (const q of questions) {
        const entry = answers.find(([key]) => key === q.question);
        if (!entry || !validUserAnswer(entry[1]) || (Array.isArray(entry[1]) && !q.multi_select)) return undefined;
        parts.push(`${JSON.stringify(q.question)}=${JSON.stringify(entry[1])}`);
    }
    return `User answers: ${parts.join(", ")}`;
}
