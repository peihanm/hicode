import {createTurnAbortController} from "../runtime/abort.js";
import {RuntimeMessageQueue} from "../runtime/messageQueue.js";
import type {AgentEvent} from "../agent/types.js";
import type {CreateSubagentThread} from "../subagents/types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import {validateBackgroundAgent} from "../subagents/registration.js";
import type {ToolContext} from "../tools/types.js";
import type {ManagedAgentTask} from "./managed.js";
import type {StartAgentTaskInput, TaskSessionBinding, TaskStatus,} from "./types.js";
import type {TaskWorktreeManager} from "./worktreeTask.js";

export function validateAgentTaskInput(
    input: StartAgentTaskInput,
    subagents: SubagentRegistry
): void {
    if (input.request.kind === "fork") {
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.request.name)) {
            throw new Error("Fork name 只能包含小写字母、数字和连字符，长度 1–40");
        }
        if (input.request.isolation !== input.isolation) {
            throw new Error("Fork request 与 Task isolation 不一致");
        }
        return;
    }
    const registration = subagents.get(input.request.agentType);
    if (!registration) {
        throw new Error(`未知 Agent 类型: ${input.request.agentType}`);
    }
    const policyIssue = validateBackgroundAgent(
        registration.definition,
        input.isolation
    );
    if (policyIssue) throw new Error(policyIssue);
}

export function createAgentTask(
    id: string,
    binding: TaskSessionBinding,
    input: StartAgentTaskInput,
    context: ToolContext,
    createSubagentThread: CreateSubagentThread,
    publishProgress: (task: ManagedAgentTask) => Promise<void>,
    worktree?: ManagedAgentTask["worktree"]
): ManagedAgentTask {
    const messageQueue = new RuntimeMessageQueue();
    let task: ManagedAgentTask;
    const thread = createSubagentThread({
        parentContext: context,
        agentId: id,
        storageCwd: input.parentContext.cwd,
        onEvent: () => {},
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
        ...(input.request.kind === "fork"
            ? {agentName: input.request.name}
            : {}),
        description: input.request.description,
        status: "running",
        startedAt: new Date().toISOString(),
        store: binding.toolResultStore,
        controller: createTurnAbortController(),
        runCount: 1,
        iterations: 0,
        toolUseCount: 0,
        lastPublishedTokenCount: 0,
        ...(worktree ? {worktree} : {}),
        notificationPending: false,
        suppressTerminalNotification: false,
        completion: Promise.resolve(),
    };
    return task;
}

export async function runAgentTask(
    task: ManagedAgentTask,
    prompt: string,
    worktrees: TaskWorktreeManager,
    publishFinished: (task: ManagedAgentTask) => Promise<void>
): Promise<void> {
    let finalStatus: TaskStatus = "failed";
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
            task.resultPreview = result.reply;
            finalStatus = result.reason === "interrupted"
                ? "cancelled"
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
            if (finalStatus === "cancelled") break;
            const queued = task.messageQueue.dequeueNextUserInput();
            if (!queued) break;
            nextPrompt = queued.content;
            resetAgentRun(task, task.runCount + 1);
        }
    } catch (error) {
        finalStatus = task.controller.signal.aborted ? "cancelled" : "failed";
        task.outputIssue = error instanceof Error ? error.message : String(error);
    } finally {
        await worktrees.finish(task);
        task.status = finalStatus;
        task.completedAt = new Date().toISOString();
        task.notificationPending = !task.suppressTerminalNotification;
        await publishFinished(task);
    }
}

export function resetAgentRun(task: ManagedAgentTask, runCount: number): void {
    task.runCount = runCount;
    task.iterations = 0;
    task.toolUseCount = 0;
    task.tokenCount = undefined;
    task.lastPublishedTokenCount = 0;
    task.lastActivity = undefined;
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
    if (event.type === "iteration") {
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
