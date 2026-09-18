import {createTurnAbortController} from "../runtime/abort.js";
import {RuntimeMessageQueue} from "../runtime/messageQueue.js";
import type {AgentEvent} from "../agent/types.js";
import type {CreateSubagentThread} from "../subagents/types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import type {ToolContext} from "../tools/types.js";
import type {ManagedAgentTask} from "./managed.js";
import type {StartAgentTaskInput, TaskSessionBinding, AgentTaskStatus,} from "./types.js";

export function validateAgentTaskInput(
    input: StartAgentTaskInput,
    subagents: SubagentRegistry
): void {
    if (input.request.name && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.request.name)) {
        throw new Error("Agent name must use lowercase letters, digits and hyphens (1–40 characters)");
    }
    const registration = subagents.get(input.request.agentType);
    if (!registration) {
        throw new Error(`Unknown Agent type: ${input.request.agentType}`);
    }

}

export function createAgentTask(
    id: string,
    binding: TaskSessionBinding,
    input: StartAgentTaskInput,
    context: ToolContext,
    createSubagentThread: CreateSubagentThread,
    publishProgress: (task: ManagedAgentTask) => Promise<void>
): ManagedAgentTask {
    const messageQueue = new RuntimeMessageQueue();
    let task: ManagedAgentTask;
    const thread = createSubagentThread({
        parentContext: context,
        agentId: id,
        storageCwd: input.parentContext.cwd,
        onEvent: () => {},
        ...(binding.messageQueue ? {agentMessaging: {
            send: async (target: string, message: string) => {
                if (target !== "parent") throw new Error("A child can message only its parent");
                if (task.stopRequested || task.status !== "running" || task.controller.signal.aborted) throw new Error("Agent run is no longer active");
                const queued = binding.messageQueue!.enqueueAgent(message, {
                    sender: id, recipient: "parent", runCount: task.runCount, intent: "message",
                });
                task.lastMessage = message;
                await publishProgress(task);
                return {messageId: queued.id};
            },
            wait: (timeoutMs: number, signal: AbortSignal) => messageQueue.waitForAgentMessage(timeoutMs, signal),
        }} : {}),
        onChildEvent: (event) => recordAgentProgress(
            task,
            event,
            publishProgress
        ),
    }, input.request);
    task = {
        id,
        owner: {
            sessionId: binding.sessionId,
            toolCallId: input.request.parentToolCallId,
        },
        thread,
        messageQueue,
        agentType: input.request.agentType,
        cwd: input.request.cwd ?? context.cwd,
        ...(input.request.name
            ? {agentName: input.request.name}
            : {}),
        description: input.request.description,
        status: "running",
        interruptRequested: false,
        stopRequested: false,
        startedAt: new Date().toISOString(),
        store: binding.toolResultStore,
        controller: createTurnAbortController(),
        runCount: 1,
        iterations: 0,
        toolUseCount: 0,
        lastPublishedTokenCount: 0,
        notificationPending: false,
        suppressTerminalNotification: false,
        completion: Promise.resolve(),
    };
    return task;
}

export async function runAgentTask(
    task: ManagedAgentTask,
    prompt: string,
    publishFinished: (task: ManagedAgentTask) => Promise<void>
): Promise<void> {
    let finalStatus: AgentTaskStatus = "failed";
    try {
        let nextPrompt = prompt;
        while (true) {
            const result = await task.thread.run({
                taskId: task.id,
                prompt: nextPrompt,
                signal: task.controller.signal,
                inputChannel: task.messageQueue.createAgentInputChannel(() => {}),
            });
            task.reason = result.reason;
            task.iterations = result.iterations;
            task.toolUseCount = result.toolUseCount;
            task.transcriptPath = result.transcriptPath;
            task.outputIssue = result.transcriptIssue;
            task.resultPreview = result.reply;
            finalStatus = result.reason === "interrupted"
                ? task.interruptRequested ? "interrupted" : "cancelled"
                : result.reason === "completed" || result.reason === "no_tool_calls"
                    ? "completed"
                    : "failed";
            try {
                task.outputResult = await task.store.persistText({
                    toolCallId: task.owner.toolCallId,
                    toolName: "task",
                    content: result.reply,
                    resultId: `task_${task.id}_run_${task.runCount}`,
                });
                task.resultPreview = task.outputResult.preview;
            } catch (error) {
                task.outputIssue = error instanceof Error
                    ? error.message
                    : String(error);
            }
            if (task.controller.signal.aborted) finalStatus = task.interruptRequested ? "interrupted" : "cancelled";
            if (finalStatus === "cancelled" || finalStatus === "interrupted") break;
            const queued = task.messageQueue.dequeueFollowup();
            if (!queued) break;
            if (typeof queued.content !== "string") throw new Error("Background Agent steering accepts text only");
            nextPrompt = queued.content;
            resetAgentRun(task, task.runCount + 1);
        }
    } catch (error) {
        finalStatus = task.controller.signal.aborted ? task.interruptRequested ? "interrupted" : "cancelled" : "failed";
        task.outputIssue = error instanceof Error ? error.message : String(error);
    } finally {
        if (task.controller.signal.aborted) finalStatus = task.interruptRequested ? "interrupted" : "cancelled";
        task.status = finalStatus;
        task.completedAt = new Date().toISOString();
        task.notificationPending = !task.suppressTerminalNotification;
        await publishFinished(task);
    }
}

export function resetAgentRun(task: ManagedAgentTask, runCount: number): void {
    task.interruptRequested = false;
    task.runCount = runCount;
    task.iterations = 0;
    task.toolUseCount = 0;
    task.tokenCount = undefined;
    task.lastPublishedTokenCount = 0;
    task.lastActivity = undefined;
    task.lastMessage = undefined;
    task.reason = undefined;
    task.resultPreview = undefined;
    task.outputResult = undefined;
    task.transcriptPath = undefined;
    task.outputIssue = undefined;
}

async function recordAgentProgress(
    task: ManagedAgentTask,
    event: AgentEvent,
    publish: (task: ManagedAgentTask) => Promise<void>
): Promise<void> {
    let shouldPublish = false;
    if (event.type === "subagent_progress" && event.event.type === "todos") {
        task.todos = event.event.todos.slice(0, 100).map(todo => ({...todo, content: todo.content.slice(0, 1024), activeForm: todo.activeForm.slice(0, 1024)}));
        shouldPublish = true;
    } else if (event.type === "iteration") {
        task.iterations = event.current;
        shouldPublish = true;
    } else if (event.type === "tool_call_start") {
        task.toolUseCount += 1;
        task.lastActivity = event.name;
        shouldPublish = true;
    } else if (event.type === "token_update") {
        task.tokenCount = event.tokenCount;
        if (event.tokenCount - task.lastPublishedTokenCount >= 256) {
            task.lastPublishedTokenCount = event.tokenCount;
            shouldPublish = true;
        }
    }
    if (shouldPublish && task.status === "running") await publish(task);
}
