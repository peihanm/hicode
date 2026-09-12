import type {PermissionResult} from "../../permissions/index.js";
import type {ToolContext} from "../types.js";

export async function checkTaskStopPermission(
    ctx: ToolContext,
    taskId: string | undefined
): Promise<PermissionResult> {
    if (!ctx.tasks) return {behavior: "deny", message: "This Runtime does not support background tasks"};
    if (!taskId) return {behavior: "deny", message: "stop requires task_id"};
    // list does not consume notifications; Runtime revalidates ownership when stopping.
    const task = (await ctx.tasks.list()).find(task =>
        task.id === taskId && task.owner.sessionId === ctx.sessionId
    );
    if (!task) return {behavior: "deny", message: `Background task not found: ${taskId}`};
    return {behavior: "allow"};
}
