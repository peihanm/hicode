import type {PermissionResult} from "../../permissions/index.js";
import type {TaskSnapshot} from "../../tasks/index.js";
import type {ToolContext} from "../types.js";

export async function checkTaskStopPermission(
    ctx: ToolContext,
    taskId: string | undefined,
    expectedKind?: TaskSnapshot["kind"]
): Promise<PermissionResult> {
    if (!ctx.tasks) return {behavior: "deny", message: "当前 Runtime 不支持后台任务"};
    if (!taskId) return {behavior: "deny", message: "stop 需要 task_id"};
    // list 不刷新 Worktree 或消费通知；实际停止时 Runtime 再次验证所有权和类型。
    const task = (await ctx.tasks.list()).find(task =>
        task.id === taskId && task.owner.sessionId === ctx.sessionId
    );
    if (!task) return {behavior: "deny", message: `后台任务不存在: ${taskId}`};
    if (expectedKind !== undefined && task.kind !== expectedKind) {
        return {behavior: "deny", message: `任务类型不匹配: 预期 ${expectedKind}，实际 ${task.kind}`};
    }
    return {behavior: "allow"};
}
