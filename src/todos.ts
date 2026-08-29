/** Shared Todo state persisted by Session and updated through todo_write. */
export interface Todo {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm: string;
}
