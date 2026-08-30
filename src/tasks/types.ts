import type {SandboxExecutionPreference} from "../sandbox/index.js";
import type {PersistedToolResult, ToolResultStore} from "../toolResults/index.js";
import type {ShellTermination} from "../tools/bash/process.js";
import type {StopReason} from "../agent/types.js";
import type {SubagentRequest} from "../subagents/types.js";
import type {ToolContext} from "../tools/types.js";
import type {AgentWorktreeSnapshot} from "../worktrees/index.js";

export type TaskStatus =
    | "running"
    | "completed"
    | "failed"
    | "cancelled";

interface TaskOwner {
    sessionId: string;
    toolCallId: string;
}

export interface ShellTaskSnapshot {
    id: string;
    kind: "shell";
    owner: TaskOwner;
    command: string;
    cwd: string;
    status: TaskStatus;
    startedAt: string;
    completedAt?: string;
    output: string;
    outputResult?: PersistedToolResult;
    outputIssue?: string;
    termination?: ShellTermination;
}

interface AgentTaskProgress {
    runCount: number;
    iterations: number;
    toolUseCount: number;
    pendingMessages: number;
    tokenCount?: number;
    lastActivity?: string;
}

export interface AgentTaskSnapshot {
    id: string;
    kind: "agent";
    owner: TaskOwner;
    agentType: string;
    agentName?: string;
    description: string;
    status: TaskStatus;
    startedAt: string;
    completedAt?: string;
    progress: AgentTaskProgress;
    reason?: StopReason;
    resultPreview?: string;
    outputResult?: PersistedToolResult;
    transcriptPath?: string;
    outputIssue?: string;
    worktree?: AgentWorktreeSnapshot;
    worktreeDiffStat?: string;
    worktreeDiffPreview?: string;
    worktreeDiffResult?: PersistedToolResult;
}

export type TaskSnapshot = ShellTaskSnapshot | AgentTaskSnapshot;

export interface RunningTaskSummary {
    total: number;
    shell: number;
    agent: number;
}

export interface StartShellTaskInput {
    command: string;
    cwd: string;
    toolCallId: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    sandboxPermissions?: SandboxExecutionPreference;
}

export interface StartAgentTaskInput {
    request: SubagentRequest;
    parentContext: ToolContext;
    isolation?: "worktree";
}

export interface TaskNotification {
    taskId: string;
    sessionId: string;
    ownerToolCallId: string;
    kind: "shell" | "agent";
    label: string;
    status: Extract<TaskStatus, "completed" | "failed" | "cancelled">;
    summary: string;
    resultId?: string;
    message: string;
}

export interface TaskEventEnvelope {
    version: 3;
    sequence: number;
    sessionId: string;
    task: TaskSnapshot;
    type: "task_started" | "task_progress" | "task_finished";
}

export interface TaskSessionLike {
    readonly sessionId: string;

    initialize(): Promise<void>;

    startShell(input: StartShellTaskInput): Promise<ShellTaskSnapshot>;

    startAgent(input: StartAgentTaskInput): Promise<AgentTaskSnapshot>;

    get(id: string): Promise<TaskSnapshot | undefined>;

    list(): Promise<readonly TaskSnapshot[]>;

    stop(id: string): Promise<TaskSnapshot | undefined>;

    send(id: string, message: string): Promise<AgentTaskSnapshot>;

    discardWorktree(id: string): Promise<AgentTaskSnapshot>;

    hasRunning(): boolean;

    getRunningSummary(): RunningTaskSummary;

    claimNotifications(): Promise<readonly TaskNotification[]>;

    subscribe(listener: (event: TaskEventEnvelope) => void): () => void;
}

export interface TaskSessionBinding {
    sessionId: string;
    toolResultStore: ToolResultStore;
    allowBackgroundTasks?: boolean;
}

export interface TaskRuntimeLike {
    forSession(binding: TaskSessionBinding): TaskSessionLike;

    hasRunning(): boolean;

    getRunningSummary(): RunningTaskSummary;

    hasRunningThatBlocksRewind(): boolean;

    close(): Promise<void>;
}
