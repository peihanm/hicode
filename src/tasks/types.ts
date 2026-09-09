import type {SandboxExecutionPreference} from "../sandbox/index.js";
import type {NetworkAccessExecution} from "../permissions/networkAccess.js";
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

export interface MemoryTaskSnapshot {
    id:string;kind:"memory";owner:{sessionId:string;turnId:string};status:TaskStatus;startedAt:string;completedAt?:string;
    resultPreview?:string;outputIssue?:string;
}
export interface StartMemoryTaskInput {signal:AbortSignal;turnId:string;background:boolean;baseline?:readonly string[];}
export type TaskSnapshot = ShellTaskSnapshot | AgentTaskSnapshot | MemoryTaskSnapshot;

export interface RunningTaskSummary {
    total: number;
    shell: number;
    agent: number;
    memory: number;
}

export interface StartShellTaskInput {
    waitMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    networkAccess?: NetworkAccessExecution;
    command: string;
    cwd: string;
    toolCallId: string;
    maxOutputBytes?: number;
    sandboxPermissions?: SandboxExecutionPreference;
    writableRoots?: readonly string[];
}

export interface StartAgentTaskInput {
    request: SubagentRequest;
    parentContext: ToolContext;
    isolation?: "worktree";
}

export interface TaskNotification {
    notificationId: string;
    taskId: string;
    sessionId: string;
    ownerToolCallId?: string;
    kind: "shell" | "agent" | "memory";
    label: string;
    status: Extract<TaskStatus, "completed" | "failed" | "cancelled">;
    summary: string;
    resultId?: string;
    message: string;
}

export interface TaskEventEnvelope {
    version: 4;
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

    startMemory(input:StartMemoryTaskInput):Promise<MemoryTaskSnapshot|undefined>;

    get(id: string): Promise<TaskSnapshot | undefined>;

    list(): Promise<readonly TaskSnapshot[]>;

    stop(id: string, expectedKind?: TaskSnapshot["kind"]): Promise<TaskSnapshot | undefined>;

    send(id: string, message: string): Promise<AgentTaskSnapshot>;

    discardWorktree(id: string): Promise<AgentTaskSnapshot>;

    hasRunning(): boolean;

    getRunningSummary(): RunningTaskSummary;

    pendingNotifications(): Promise<readonly TaskNotification[]>;

    acknowledgeNotification(notification: Pick<TaskNotification, "taskId" | "notificationId">): Promise<void>;

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


    close(): Promise<void>;
}
