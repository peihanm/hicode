import {createTurnAbortController} from "../runtime/abort.js";
import type {AgentEvent} from "../agent/types.js";
import type {CreateSubagentRunner} from "../subagents/types.js";
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
    worktree?: ManagedAgentTask["worktree"]
): {task: ManagedAgentTask; context: ToolContext} {
    return {
        context,
        task: {
            id,
            owner: {
                sessionId: binding.sessionId,
                toolCallId: input.request.parentToolCallId,
            },
            agentType: input.request.agentType,
            ...(input.request.kind === "fork"
                ? {agentName: input.request.name}
                : {}),
            description: input.request.description,
            status: "running",
            startedAt: new Date().toISOString(),
            store: binding.toolResultStore,
            controller: createTurnAbortController(),
            iterations: 0,
            toolUseCount: 0,
            lastPublishedTokenCount: 0,
            ...(worktree ? {worktree} : {}),
            notificationPending: false,
            suppressTerminalNotification: false,
            completion: Promise.resolve(),
        },
    };
}

export async function runAgentTask(
    task: ManagedAgentTask,
    input: StartAgentTaskInput,
    executionContext: ToolContext,
    createSubagentRunner: CreateSubagentRunner,
    worktrees: TaskWorktreeManager,
    publishProgress: (task: ManagedAgentTask) => Promise<void>,
    publishFinished: (task: ManagedAgentTask) => Promise<void>
): Promise<void> {
    const runner = createSubagentRunner({
        parentContext: executionContext,
        signal: task.controller.signal,
        agentId: task.id,
        storageCwd: input.parentContext.cwd,
        onEvent: () => {},
        onChildEvent: (event) => recordAgentProgress(
            task,
            event,
            publishProgress
        ),
    });
    let finalStatus: TaskStatus = "failed";
    try {
        const result = await runner(input.request);
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
                resultId: `task_${task.id}`,
            });
            task.resultPreview = task.outputResult.preview;
        } catch (error) {
            task.outputIssue = error instanceof Error
                ? error.message
                : String(error);
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
