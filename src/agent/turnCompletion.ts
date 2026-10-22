import type {Todo} from "../session/todo.js";

function sanitizeCandidateReply(reply: string): string {
    return reply
        .replace(/<\/?(?:system-reminder|candidate-reply)>/gi, "[reserved tag removed]")
        .slice(0, 8_000);
}

/** Every final candidate must reconcile the live structured Todo state. */
export function formatTodoCompletionReminder(
    candidateReply: string,
    todos: readonly Todo[]
): string | undefined {
    const unfinishedTodos = todos.filter((todo) => todo.status !== "completed");
    if (unfinishedTodos.length === 0) return undefined;

    return [
        "<system-reminder>",
        "This session still has unfinished todos (pending or in_progress):",
        ...unfinishedTodos.map((todo) => `- [${todo.status}] ${todo.content}`),
        "A final answer cannot end this turn while pending or in_progress todos remain. If actually done, call todo_write to mark completed; otherwise continue the work. Marking an item pending does not resolve it. Remove items only when their scope is obsolete or cancelled; never mark unfinished work complete or clear the list just to pass this check. If blocked, use available communication tools to report the blocker and seek direction. This check repeats for every final answer until the unfinished list is resolved; cancellation and execution limits still stop the turn.",
        "Previous candidate answer:",
        "<candidate-reply>",
        sanitizeCandidateReply(candidateReply),
        "</candidate-reply>",
        "Preserve valid information from the candidate and correct the missing state. Provide a complete final answer in the user's language, not just an addendum or repeated completion claim.",
        "</system-reminder>",
    ].join("\n");
}
