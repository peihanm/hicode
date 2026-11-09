import type {Todo} from "../session/todo.js";
import type {ToolCallOutcome} from "./toolBatch.js";

const REMINDER_INTERVAL = 10;

/** Turn-local cadence only; the Host getter remains the owner of Todo state. */
export class TodoProgress {
    private roundsSinceUpdate = 0;
    private roundsSinceReminder = 0;

    recordToolBatch(outcomes: readonly ToolCallOutcome[], todos: readonly Todo[]): void {
        if (!todos.some(todo => todo.status !== "completed")) {
            this.roundsSinceUpdate = 0;
            this.roundsSinceReminder = 0;
            return;
        }
        if (outcomes.some(outcome => outcome.name === "todo_write" && outcome.outcome === "ok")) {
            this.roundsSinceUpdate = 0;
        } else if (outcomes.length > 0) {
            this.roundsSinceUpdate++;
        }
        if (outcomes.length > 0) this.roundsSinceReminder++;
    }

    takeReminder(todos: readonly Todo[], toolAvailable: boolean): string | undefined {
        if (!toolAvailable || !todos.some(todo => todo.status !== "completed") ||
            this.roundsSinceUpdate < REMINDER_INTERVAL || this.roundsSinceReminder < REMINDER_INTERVAL) {
            return undefined;
        }
        this.roundsSinceReminder = 0;
        return [
            "<system-reminder>",
            "Todo progress check: the list has not been updated for at least 10 tool rounds. Check whether it matches the actual work.",
            "If the work has moved on, use todo_write to update completed and current items before proceeding. Prose does not update the list.",
            "If still working on the same item, continue without a redundant update. Remove or adjust obsolete tasks; never mark incomplete work complete.",
            "The current list appears in this request's runtime state.",
            "</system-reminder>",
        ].join("\n");
    }
}


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
