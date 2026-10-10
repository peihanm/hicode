import type {TaskSessionLike} from "./types.js";

/** A child can manage only Shell tasks it created. Root retains resource ownership. */
export type ChildTaskAccess = Pick<TaskSessionLike, "sessionId" | "shellContinuation" | "startShell" | "runShell" | "get" | "readShellOutput" | "list" | "stop" | "subscribe" | "acknowledgeNotification">;

export function isParentTaskSession(tasks: TaskSessionLike | ChildTaskAccess): tasks is TaskSessionLike {
    return "startAgent" in tasks;
}

/** The creator owns disposal; tools receive only the narrowed tasks capability. */
export interface ChildShellSession {tasks: ChildTaskAccess; close(): Promise<void>;}
