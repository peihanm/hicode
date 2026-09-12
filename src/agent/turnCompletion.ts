import type {Todo} from "../todos.js";

function sanitizeCandidateReply(reply: string): string {
    return reply
        .replace(/<\/?(?:system-reminder|candidate-reply)>/gi, "[reserved tag removed]")
        .slice(0, 8_000);
}

/** Only structured Todo state can request this bounded final-answer nudge. */
export function formatTodoCompletionReminder(
    candidateReply: string,
    todos: readonly Todo[]
): string | undefined {
    const inProgressTodos = todos.filter((todo) => todo.status === "in_progress");
    if (inProgressTodos.length === 0) return undefined;

    return [
        "<system-reminder>",
        "This session still has in_progress todos:",
        ...inProgressTodos.map((todo) => `- ${todo.content}`),
        "No further foreground work runs after this turn ends. If done, call todo_write to mark completed; if unfinished, continue working; if deferred, mark pending and explain the remaining work accurately. Resolve this state before submitting the final answer.",
        "Previous candidate answer:",
        "<candidate-reply>",
        sanitizeCandidateReply(candidateReply),
        "</candidate-reply>",
        "Preserve valid information from the candidate and correct the missing state. Provide a complete final answer in the user's language, not just an addendum or repeated completion claim.",
        "</system-reminder>",
    ].join("\n");
}
