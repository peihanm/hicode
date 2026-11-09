import {formatHookContext} from "../hooks/index.js";
import {throwIfTurnAborted} from "../runtime/abort.js";
import type {Message} from "../llm/types.js";
import type {Todo} from "../session/todo.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentEvent} from "./types.js";
import type {AgentInputChannel, QueuedAgentInput} from "./inputChannel.js";
import type {ResponseDraft} from "./draft.js";
import {formatTodoCompletionReminder} from "./todoProgress.js";

type CompletionDecision =
    | {action: "continue"; reminder?: string}
    | {action: "limit"}
    | {action: "finish"; reply: string; reason: "completed" | "hook_error" | "hook_limit"};

/** Turn-owned completion policy; tasks and Todo remain owned by their existing runtimes. */
export function createTurnCompletion({history, ctx, inputChannel, draft, onEvent, appendQueuedInputs, getTodos}: {
    history: Message[];
    ctx: ToolContext;
    inputChannel: AgentInputChannel;
    draft: ResponseDraft;
    onEvent(event: AgentEvent): void | Promise<void>;
    appendQueuedInputs(inputs: readonly QueuedAgentInput[]): Promise<void>;
    getTodos(): readonly Todo[];
}) {
    let hookContinuationUsed = false;
    return async (textContent: string, hasNextIteration: boolean): Promise<CompletionDecision> => {
        if (!hasNextIteration && ctx.taskJoin?.ids.length) {
            history.pop();
            await draft.finish("discarded");
            return {action: "limit"};
        }
        if (hasNextIteration && ctx.taskJoin?.ids.length) {
            history.pop();
            await draft.finish("discarded");
            let queued = inputChannel.drainSafeBoundary().filter(input => !ctx.taskJoin || ctx.taskJoin.accepts(input));
            await appendQueuedInputs(queued);
            let ready = await ctx.taskJoin.collect();
            let taskWaitElapsed = false;
            while (!queued.length && !ready.length && ctx.taskJoin.ids.length) {
                await onEvent({type: "task_wait", taskIds: ctx.taskJoin.ids});
                try {
                    taskWaitElapsed = await ctx.taskJoin.wait(ctx.signal, signal => inputChannel.waitForInput(signal)) === "timeout";
                } finally {
                    await onEvent({type: "task_wait", taskIds: []});
                }
                throwIfTurnAborted(ctx.signal);
                queued = inputChannel.drainSafeBoundary().filter(input => !ctx.taskJoin || ctx.taskJoin.accepts(input));
                await appendQueuedInputs(queued);
                ready = await ctx.taskJoin.collect();
                if (taskWaitElapsed) break;
            }
            await appendQueuedInputs(ready);
            await ctx.commitToolBatch?.();
            const reminder = taskWaitElapsed && ctx.taskJoin.ids.length
                ? `The task result wait window elapsed. Pending task IDs: ${ctx.taskJoin.ids.join(", ")}. These tasks have not been stopped or declared failed. Inspect progress with task wait and an explicit task_id, adjust wait_ms to the task, continue independent work, or stop an unnecessary command. Complete verification before the final answer.`
                : "Continue the current task. Inspect task results, integrate changes, and run the remaining checks before the final answer.";
            return {action: "continue", reminder};
        }
        const completionReminder = formatTodoCompletionReminder(textContent, getTodos());
        if (completionReminder) {
            history.pop();
            await draft.finish("discarded");
            if (!hasNextIteration) return {action: "limit"};
            await appendQueuedInputs(inputChannel.drainSafeBoundary());
            return {action: "continue", reminder: completionReminder};
        }
        if (hasNextIteration) {
            const queued = inputChannel.drainSafeBoundary().filter(input => !ctx.taskJoin || ctx.taskJoin.accepts(input));
            if (queued.length > 0) {
                await onEvent({type: "assistant_text", content: textContent, phase: "final"});
                await appendQueuedInputs(queued);
                return {action: "continue"};
            }
        }
        if (ctx.runHook) {
            const hook = await ctx.runHook({hook_event_name: "Stop", session_id: ctx.sessionId,
                turn_id: ctx.turnId, candidate: textContent, continuation_used: hookContinuationUsed});
            throwIfTurnAborted(ctx.signal);
            if (hook.error || hook.continueReason) {
                if (!hook.error && !hookContinuationUsed && hasNextIteration) {
                    history.pop();
                    hookContinuationUsed = true;
                    const reminder = formatHookContext("Stop", [hook.continueReason!, ...hook.additionalContexts]).join("\n");
                    return {action: "continue", reminder};
                }
                const reply = `${textContent}\n\nHook ${hook.error ? "Check failed" : "Continuation limit reached"}: ${hook.error ?? hook.continueReason}`;
                // Keep the candidate as evidence, with the failed acceptance explicitly attached.
                history[history.length - 1] = {role: "assistant", content: reply};
                await onEvent({type: "assistant_text", content: reply, phase: "final"});
                return {action: "finish", reply, reason: hook.error ? "hook_error" : "hook_limit"};
            }
        }
        await onEvent({type: "assistant_text", content: textContent, phase: "final"});
        return {action: "finish", reply: textContent, reason: "completed"};
    };
}
