import {z} from "zod";
import type {Tool, ToolContext} from "../types.js";
import type {PermissionResult} from "../../permissions/index.js";

// TodoWrite replaces the complete task list.
// Based on Claude Code src/tools/TodoWriteTool/TodoWriteTool.ts.
//
// Each call provides the complete todos array, not a delta.
//
// checkPermissions allows directly: todos only update UI state.
// Inject setTodos through ToolContext to avoid coupling tools to React.

const todoSchema = z.object({
    content: z.string().describe("Task description in imperative form, e.g. 'Fix the auth bug'; use the user's language."),
    status: z.enum(["pending", "in_progress", "completed"]),
    activeForm: z.string().describe(
        "In-progress wording for the spinner, e.g. 'Fixing the auth bug'; use the user's language."
    ),
});

const inputSchema = z.object({
    todos: z.array(todoSchema).describe("Complete task list; replaces the list rather than appending a delta."),
});

type Input = z.infer<typeof inputSchema>;

export const todoWriteTool: Tool<typeof inputSchema> = {
    name: "todo_write",
    description: "Replace the complete task list. Use for multi-step work or multiple requested tasks, not trivial questions. Keep at most one item in_progress. At each meaningful transition, mark finished work completed and the next item in_progress before doing it; do not postpone all updates until the final answer. Prose does not update state. Keep unfinished items honest; adjust/remove obsolete scope and avoid redundant updates while still doing the same step. Write user-facing content/activeForm in the user's language.",
    parameters: inputSchema,

    isReadOnly: () => true,

    async checkPermissions(): Promise<PermissionResult> {
        // Todo updates have no external side effects; allow directly.
        return {behavior: "allow"};
    },

    async execute({todos}: Input, ctx: ToolContext): Promise<string> {
        // Clear todos when all are complete, following Claude Code TodoWriteTool.
        // Hide the completed list instead of leaving all checkmarks on screen.
        const allDone = todos.length > 0 && todos.every((t) => t.status === "completed");
        await ctx.setTodos(allDone ? [] : todos);
        return allDone
            ? "All tasks completed; the list has been cleared."
            : "Todos updated. Before starting the next task, update completed items and the next in-progress item.";
    },
};
