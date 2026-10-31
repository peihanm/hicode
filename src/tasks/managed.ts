import type {Todo} from "../session/todo.js";
import type {MemoryTaskSnapshot, TaskReviewSnapshot} from "./types.js";
import type {StopReason} from "../agent/types.js";
import {readOutputPreview} from "./shell/output.js";
import type {ToolResultStore} from "../toolResults/index.js";
import type {ShellExecutionResult, ShellTermination} from "../tools/bash/process.js";
import type {SubagentThread} from "../subagents/types.js";
import type {RuntimeMessageQueue} from "../runtime/messageQueue.js";
import type {AgentTaskSnapshot, ShellTaskSnapshot, TaskSnapshot, TaskStatus, AgentTaskStatus,} from "./types.js";

interface ManagedTaskBase<Status extends string = TaskStatus> {
    id: string;
    owner: {sessionId: string; toolCallId: string};
    status: Status;
    startedAt: string;
    completedAt?: string;
    controller: AbortController;
    outputIssue?: string;
    notificationPending: boolean;
    suppressTerminalNotification: boolean;
    completion: Promise<void>;
}

export interface ManagedShellTask extends ManagedTaskBase {
    kind: "shell";
    store: ToolResultStore;
    phase: ShellTaskSnapshot["phase"];
    createdTick: number;
    acquiredTick?: number;
    processStartedTick?: number;
    processStartedAt?: string;
    finishedTick?: number;
    published: boolean;
    publication: Promise<void>;
    inlineResult?: ShellExecutionResult;
    executionMode: "sandbox" | "host";
    command: string;
    cwd: string;
    outputPath: string;
    termination?: ShellTermination;
    outputResult?: ShellTaskSnapshot["outputResult"];
    outputPreview?: string;
}

export interface ManagedAgentTask extends ManagedTaskBase<AgentTaskStatus> {
    kind: "agent";
    store: ToolResultStore;
    interruptRequested: boolean;
    stopRequested: boolean;
    cwd: string;
    thread: SubagentThread;
    messageQueue: RuntimeMessageQueue;
    agentType: string;
    agentName?: string;
    description: string;
    runCount: number;
    runStartedAt: string;
    previousDurationMs: number;
    todosUpdated: boolean;
    iterations: number;
    toolUseCount: number;
    tokenCount?: number;
    lastPublishedTokenCount: number;
    pendingApprovals: Set<string>;
    lastActivity?: string;
    lastMessage?: string;
    todos?: Todo[];
    reason?: StopReason;
    resultPreview?: string;
    outputResult?: AgentTaskSnapshot["outputResult"];
    transcriptPath?: string;
}

export interface ManagedMemoryTask extends Omit<ManagedTaskBase,"owner"> {kind:"memory";owner:{sessionId:string;turnId:string};resultPreview?:string;}
export interface ManagedReviewTask extends Omit<ManagedTaskBase, "owner"> {
    kind: "review";
    owner: {sessionId: string; turnId: string};
    fromRound: number;
    toRound: number;
    resultPreview?: string;
}
export type ManagedTask = ManagedShellTask | ManagedAgentTask | ManagedMemoryTask | ManagedReviewTask;
export function isReviewTask(task: ManagedTask): task is ManagedReviewTask {return task.kind === "review";}
export function snapshotReview(task: ManagedReviewTask): TaskReviewSnapshot {
    return {id: task.id, kind: "review", owner: task.owner, status: task.status, startedAt: task.startedAt,
        fromRound: task.fromRound, toRound: task.toRound,
        ...(task.completedAt ? {completedAt: task.completedAt} : {}),
        ...(task.resultPreview ? {resultPreview: task.resultPreview} : {}),
        ...(task.outputIssue ? {outputIssue: task.outputIssue} : {})};
}
export function isMemoryTask(task:ManagedTask):task is ManagedMemoryTask{return task.kind === "memory";}
export function isAgentTask(task:ManagedTask):task is ManagedAgentTask{return task.kind === "agent";}
export function snapshotMemory(task:ManagedMemoryTask):MemoryTaskSnapshot {
 return {id:task.id,kind:"memory",owner:task.owner,status:task.status,startedAt:task.startedAt,...(task.completedAt?{completedAt:task.completedAt}:{}),...(task.outputIssue?{outputIssue:task.outputIssue}:{}),...(task.resultPreview?{resultPreview:task.resultPreview}:{})};
}

export function isShellTask(task: ManagedTask): task is ManagedShellTask {
    return task.kind === "shell";
}

export function appendTaskIssue(task: ManagedTask, issue: string): void {
    if (task.outputIssue?.includes(issue)) return;
    task.outputIssue = [task.outputIssue, issue].filter(Boolean).join(";");
}

export async function snapshotShell(
    task: ManagedShellTask
): Promise<ShellTaskSnapshot> {
    return {
        id: task.id,
        kind: "shell",
        executionMode: task.executionMode,
        phase: task.phase,
        timing: {queuedMs: Math.max(0, Math.round((task.acquiredTick ?? task.finishedTick ?? performance.now()) - task.createdTick)),
            runningMs: task.processStartedTick === undefined ? 0 : Math.max(0, Math.round((task.finishedTick ?? performance.now()) - task.processStartedTick))},
        ...(task.processStartedAt ? {processStartedAt: task.processStartedAt} : {}),
        owner: task.owner,
        command: task.command,
        cwd: task.cwd,
        status: task.status,
        startedAt: task.startedAt,
        ...(task.completedAt ? {completedAt: task.completedAt} : {}),
        output: task.outputPreview ?? await readOutputPreview(task.outputPath),
        ...(task.outputResult ? {outputResult: task.outputResult} : {}),
        ...(task.outputIssue ? {outputIssue: task.outputIssue} : {}),
        ...(task.termination ? {termination: task.termination} : {}),
    };
}

export function snapshotAgent(task: ManagedAgentTask): AgentTaskSnapshot {
    return {
        id: task.id,
        kind: "agent",
        cwd: task.cwd,
        owner: task.owner,
        agentType: task.agentType,
        ...(task.agentName ? {agentName: task.agentName} : {}),
        description: task.description,
        status: task.status,
        startedAt: task.startedAt,
        progress: {
            runCount: task.runCount,
            runStartedAt: task.runStartedAt,
            previousDurationMs: task.previousDurationMs,
            todosUpdated: task.todosUpdated,
            iterations: task.iterations,
            toolUseCount: task.toolUseCount,
            pendingMessages: task.messageQueue.list().length,
            ...(task.tokenCount !== undefined
                ? {tokenCount: task.tokenCount}
                : {}),
            ...(task.pendingApprovals.size ? {lastActivity: `Waiting for permission (${task.pendingApprovals.size})`} : task.lastActivity ? {lastActivity: task.lastActivity} : {}),
            ...(task.lastMessage ? {lastMessage: task.lastMessage} : {}),
            ...(task.todos ? {todos: structuredClone(task.todos)} : {}),
        },
        ...(task.completedAt ? {completedAt: task.completedAt} : {}),
        ...(task.reason ? {reason: task.reason} : {}),
        ...(task.resultPreview ? {resultPreview: task.resultPreview} : {}),
        ...(task.outputResult ? {outputResult: task.outputResult} : {}),
        ...(task.transcriptPath ? {transcriptPath: task.transcriptPath} : {}),
        ...(task.outputIssue ? {outputIssue: task.outputIssue} : {}),
    };
}

export function snapshotTask(task: ManagedTask): Promise<TaskSnapshot> {
    return isReviewTask(task) ? Promise.resolve(snapshotReview(task)) : isMemoryTask(task) ? Promise.resolve(snapshotMemory(task)) : isShellTask(task)
        ? snapshotShell(task)
        : Promise.resolve(snapshotAgent(task));
}
