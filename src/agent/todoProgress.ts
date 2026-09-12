import type {Todo} from "../todos.js";
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
