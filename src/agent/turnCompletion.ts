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
        "当前 Session 仍有标记为 in_progress 的 Todo：",
        ...inProgressTodos.map((todo) => `- ${todo.content}`),
        "本轮结束后不会再有工作实际执行，因此不能保留『正在进行』状态。若任务已经完成，先调用 todo_write 标记 completed；若尚未完成则继续执行；若决定暂缓，改为 pending 并在最终回答中准确说明。不要直接提交最终回答。",
        "上一版候选回答如下：",
        "<candidate-reply>",
        sanitizeCandidateReply(candidateReply),
        "</candidate-reply>",
        "请保留候选回答中的有效信息，在其基础上修正上面的缺失；不要缩减成只补充一条说明，也不要仅重复完成声明。",
        "</system-reminder>",
    ].join("\n");
}
