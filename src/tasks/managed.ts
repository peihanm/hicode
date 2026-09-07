import type {MemoryTaskSnapshot} from "./types.js";
import {type FileHandle, open} from "node:fs/promises";
import type {StopReason} from "../agent/types.js";
import {selectUtf8Range} from "../toolResults/utf8.js";
import type {ToolResultStore} from "../toolResults/index.js";
import type {ShellTermination} from "../tools/bash/process.js";
import type {AgentWorktreeRecord, WorktreeInspection} from "../worktrees/index.js";
import type {SubagentThread} from "../subagents/types.js";
import type {RuntimeMessageQueue} from "../runtime/messageQueue.js";
import type {AgentTaskSnapshot, ShellTaskSnapshot, TaskSnapshot, TaskStatus,} from "./types.js";

const OUTPUT_PREVIEW_BYTES = 20_000;

interface ManagedTaskBase {
    id: string;
    owner: {sessionId: string; toolCallId: string};
    status: TaskStatus;
    startedAt: string;
    completedAt?: string;
    store: ToolResultStore;
    controller: AbortController;
    outputIssue?: string;
    notificationPending: boolean;
    suppressTerminalNotification: boolean;
    completion: Promise<void>;
}

export interface ManagedShellTask extends ManagedTaskBase {
    command: string;
    cwd: string;
    outputPath: string;
    termination?: ShellTermination;
    outputResult?: ShellTaskSnapshot["outputResult"];
    outputPreview?: string;
}

export interface ManagedAgentTask extends ManagedTaskBase {
    thread: SubagentThread;
    messageQueue: RuntimeMessageQueue;
    agentType: string;
    agentName?: string;
    description: string;
    runCount: number;
    iterations: number;
    toolUseCount: number;
    tokenCount?: number;
    lastPublishedTokenCount: number;
    lastActivity?: string;
    reason?: StopReason;
    resultPreview?: string;
    outputResult?: AgentTaskSnapshot["outputResult"];
    transcriptPath?: string;
    worktree?: AgentWorktreeRecord;
    worktreeInspection?: WorktreeInspection;
    worktreeDiffStat?: string;
    worktreeDiffRevision?: string;
    worktreeDiffPreview?: string;
    worktreeDiffResult?: AgentTaskSnapshot["worktreeDiffResult"];
}

export interface ManagedMemoryTask extends Omit<ManagedTaskBase,"owner"> {kind:"memory";owner:{sessionId:string;turnId:string};resultPreview?:string;}
export type ManagedTask = ManagedShellTask | ManagedAgentTask | ManagedMemoryTask;
export function isMemoryTask(task:ManagedTask):task is ManagedMemoryTask{return "kind" in task && task.kind==="memory";}
export function isAgentTask(task:ManagedTask):task is ManagedAgentTask{return "thread" in task;}
export function snapshotMemory(task:ManagedMemoryTask):MemoryTaskSnapshot {
 return {id:task.id,kind:"memory",owner:task.owner,status:task.status,startedAt:task.startedAt,...(task.completedAt?{completedAt:task.completedAt}:{}),...(task.outputIssue?{outputIssue:task.outputIssue}:{}),...(task.resultPreview?{resultPreview:task.resultPreview}:{})};
}

export function isShellTask(task: ManagedTask): task is ManagedShellTask {
    return "command" in task;
}

export function appendTaskIssue(task: ManagedTask, issue: string): void {
    if (task.outputIssue?.includes(issue)) return;
    task.outputIssue = [task.outputIssue, issue].filter(Boolean).join("；");
}

export function worktreeSnapshot(
    record: AgentWorktreeRecord,
    inspection?: WorktreeInspection,
    revision?: string
) {
    return {
        path: record.path,
        branch: record.branch,
        baseCommit: record.baseCommit,
        state: record.state,
        sourceHadChanges: record.sourceHadChanges,
        changedFiles: [...(inspection?.changedFiles ?? [])],
        ...(inspection?.status === "available" && inspection.omittedChangedFiles > 0
            ? {omittedChangedFiles: inspection.omittedChangedFiles}
            : {}),
        ...(inspection?.status === "available"
            ? {
                headCommit: inspection.headCommit,
                dirty: inspection.dirty,
                commitsAhead: inspection.commitsAhead,
            }
            : {}),
        ...(revision ? {revision} : {}),
        ...(record.cleanupReason ? {cleanupReason: record.cleanupReason} : {}),
        ...(inspection?.status === "unavailable"
            ? {issue: inspection.issue}
            : record.issue
                ? {issue: record.issue}
                : {}),
    };
}

export async function readOutputPreview(path: string): Promise<string> {
    let handle: FileHandle | undefined;
    try {
        handle = await open(path, "r");
        const {size} = await handle.stat();
        const start = Math.max(0, size - OUTPUT_PREVIEW_BYTES - 4);
        const buffer = Buffer.alloc(size - start);
        const {bytesRead} = await handle.read(buffer, 0, buffer.length, start);
        const selected = selectUtf8Range(buffer.subarray(0, bytesRead), bytesRead);
        const output = selected.content.toString("utf8");
        return start > 0 ? `[前 ${start} 字节已省略]\n${output}` : output;
    } catch {
        return "";
    } finally {
        await handle?.close().catch(() => {});
    }
}

export async function snapshotShell(
    task: ManagedShellTask
): Promise<ShellTaskSnapshot> {
    return {
        id: task.id,
        kind: "shell",
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
        owner: task.owner,
        agentType: task.agentType,
        ...(task.agentName ? {agentName: task.agentName} : {}),
        description: task.description,
        status: task.status,
        startedAt: task.startedAt,
        progress: {
            runCount: task.runCount,
            iterations: task.iterations,
            toolUseCount: task.toolUseCount,
            pendingMessages: task.messageQueue.list().length,
            ...(task.tokenCount !== undefined
                ? {tokenCount: task.tokenCount}
                : {}),
            ...(task.lastActivity ? {lastActivity: task.lastActivity} : {}),
        },
        ...(task.completedAt ? {completedAt: task.completedAt} : {}),
        ...(task.reason ? {reason: task.reason} : {}),
        ...(task.resultPreview ? {resultPreview: task.resultPreview} : {}),
        ...(task.outputResult ? {outputResult: task.outputResult} : {}),
        ...(task.transcriptPath ? {transcriptPath: task.transcriptPath} : {}),
        ...(task.outputIssue ? {outputIssue: task.outputIssue} : {}),
        ...(task.worktree
            ? {worktree: worktreeSnapshot(task.worktree, task.worktreeInspection, task.worktreeDiffRevision)}
            : {}),
        ...(task.worktreeDiffStat
            ? {worktreeDiffStat: task.worktreeDiffStat}
            : {}),
        ...(task.worktreeDiffPreview
            ? {worktreeDiffPreview: task.worktreeDiffPreview}
            : {}),
        ...(task.worktreeDiffResult
            ? {worktreeDiffResult: task.worktreeDiffResult}
            : {}),
    };
}

export function snapshotTask(task: ManagedTask): Promise<TaskSnapshot> {
    return isMemoryTask(task) ? Promise.resolve(snapshotMemory(task)) : isShellTask(task)
        ? snapshotShell(task)
        : Promise.resolve(snapshotAgent(task));
}
