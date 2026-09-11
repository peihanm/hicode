import type {PermissionResult} from "../../permissions/index.js";
import type {ToolContext} from "../types.js";

export async function checkTaskStopPermission(
    ctx: ToolContext,
    taskId: string | undefined
): Promise<PermissionResult> {
    if (!ctx.tasks) return {behavior: "deny", message: "当前 Runtime 不支持后台任务"};
    if (!taskId) return {behavior: "deny", message: "stop 需要 task_id"};
    // list 不消费通知；实际停止时 Runtime 再次验证所有权。
    const task = (await ctx.tasks.list()).find(task =>
        task.id === taskId && task.owner.sessionId === ctx.sessionId
    );
    if (!task) return {behavior: "deny", message: `后台任务不存在: ${taskId}`};
    return {behavior: "allow"};
}
