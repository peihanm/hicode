import type {ToolContext} from "../tools/types.js";
import type {RuntimeMessageQueue} from "./messageQueue.js";

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

/** One Session owns outstanding questions, including answers arriving between Turns. */
export function createSessionUserQuestions(input: {
    queue: RuntimeMessageQueue;
    persistIfIdle(): Promise<void>;
}) {
    const controller = new AbortController();
    const pending = new Set<string>();
    const issues: string[] = [];
    return {
        forTurn(signal: AbortSignal, canUseTool: ToolContext["canUseTool"]): NonNullable<ToolContext["userQuestions"]> {
            return {
                ask(question, requestId) {
                    if (signal.aborted || controller.signal.aborted) throw new Error("Question request cancelled");
                    if (pending.size >= 4 || pending.has(requestId)) throw new Error("Too many pending questions or duplicate request ID");
                    const frozen = structuredClone(question);
                    pending.add(requestId);
                    const questionSignal = AbortSignal.any([signal, controller.signal]);
                    // Normal Turn completion does not cancel its unanswered questions.
                    void Promise.resolve().then(() => {
                        questionSignal.throwIfAborted();
                        return canUseTool("ask_user", frozen.questions[0]!.question, structuredClone(frozen), {
                            signal: questionSignal, allowPersistent: false, questionDelivery: "async",
                        });
                    }).then(async decision => {
                        if (questionSignal.aborted) return;
                        if (decision.behavior !== "allow") {
                            input.queue.enqueueRuntime(`Question request ${requestId} was declined or unavailable: ${decision.message}. No answer or authorization was supplied.`);
                            await input.persistIfIdle();
                            return;
                        }
                        const answer = formatUserAnswers(frozen.questions, decision.answers);
                        if (!answer || decision.directoryScope || decision.networkScope) throw new Error("Invalid asynchronous user answers");
                        input.queue.enqueueUserAnswer(`Response to question request ${requestId}:\n${answer}`);
                        await input.persistIfIdle();
                    }).catch(error => {
                        if (!questionSignal.aborted) {
                            const issue = `Question ${requestId}: ${String(error)}`;
                            issues.push(issue);
                            if (issues.length > 32) issues.shift();
                            try {input.queue.enqueueRuntime(issue);} catch { /* Retain undeliverable failures in diagnostics. */ }
                        }
                    }).finally(() => pending.delete(requestId));
                    return requestId;
                },
            };
        },
        takeIssues: () => issues.splice(0),
        close() {
            controller.abort("session-ended");
            pending.clear();
        },
    };
}
