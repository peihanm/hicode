import type {MemoryRuntimeLike} from "../memory/runtime.js";
import {isMemoryTask,isAgentTask,snapshotMemory,type ManagedMemoryTask} from "./managed.js";
import type {StartMemoryTaskInput,MemoryTaskSnapshot} from "./types.js";
import {randomUUID} from "node:crypto";
import {createTurnAbortController} from "../runtime/abort.js";
import type {ShellRunnerLike} from "../tools/bash/shellRunner.js";
import type {CreateSubagentThread} from "../subagents/types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import type {PillarStorageLayout} from "../persistence/index.js";
import type {ChildProcessEnvironment} from "../runtime/childEnvironment.js";
import {
    type AgentWorktreeRecord,
    createWorktreeRuntime,
    type WorktreeRuntimeLike,
} from "../worktrees/index.js";
import {createTaskJournal, type TaskJournalLike} from "./journal.js";
import {
    appendTaskIssue,
    isShellTask,
    type ManagedAgentTask,
    type ManagedTask,
    snapshotAgent,
    snapshotShell,
    snapshotTask,
    worktreeSnapshot,
} from "./managed.js";
import {TaskNotificationCenter, taskNotificationId, isExpectedShellShutdown} from "./notifications.js";
import {createShellTask, runShellTask} from "./shellTask.js";
import {
    createAgentTask,
    resetAgentRun,
    runAgentTask,
    validateAgentTaskInput,
} from "./agentTask.js";
import {TaskWorktreeManager} from "./worktreeTask.js";
import type {
    AgentTaskSnapshot,
    ShellTaskSnapshot,
    StartAgentTaskInput,
    StartShellTaskInput,
    TaskEventEnvelope,
    TaskNotification,
    RunningTaskSummary,
    TaskRuntimeLike,
    TaskSessionBinding,
    TaskSessionLike,
    TaskSnapshot,
} from "./types.js";

const MAX_TRACKED_TASKS = 32;
const MAX_RUNNING_AGENT_TASKS_PER_SESSION = 4;
const SHELL_STARTUP_OBSERVATION_MS = 600;

async function observeShellStartup(completion: Promise<void>, waitMs = SHELL_STARTUP_OBSERVATION_MS): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            completion.then(() => true),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), waitMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

class TaskSession implements TaskSessionLike {
    readonly sessionId: string;
    private readonly ready: Promise<void>;

    constructor(
        private readonly runtime: TaskRuntime,
        private readonly binding: TaskSessionBinding
    ) {
        this.sessionId = binding.sessionId;
        this.ready = runtime.ensureSession(binding.sessionId);
    }

    initialize(): Promise<void> {
        return this.ready;
    }

    async startShell(input: StartShellTaskInput): Promise<ShellTaskSnapshot> {
        if (this.binding.allowBackgroundTasks === false) {
            throw new Error("当前运行模式不支持后台任务");
        }
        await this.ready;
        return this.runtime.startShell(this.binding, input);
    }

    async startAgent(input: StartAgentTaskInput): Promise<AgentTaskSnapshot> {
        if (this.binding.allowBackgroundTasks === false) {
            throw new Error("当前运行模式不支持后台任务");
        }
        await this.ready;
        return this.runtime.startAgent(this.binding, input);
    }

    async startMemory(input:StartMemoryTaskInput):Promise<MemoryTaskSnapshot|undefined> {
        if(input.background&&this.binding.allowBackgroundTasks===false)return undefined;
        await this.ready;return this.runtime.startMemory(this.binding,input);
    }

    async get(id: string): Promise<TaskSnapshot | undefined> {
        await this.ready;
        return this.runtime.get(this.binding, id);
    }

    async list(): Promise<readonly TaskSnapshot[]> {
        await this.ready;
        return this.runtime.list(this.sessionId);
    }

    async stop(id: string, expectedKind?: TaskSnapshot["kind"]): Promise<TaskSnapshot | undefined> {
        await this.ready;
        return this.runtime.stop(this.sessionId, id, expectedKind);
    }

    async send(id: string, message: string): Promise<AgentTaskSnapshot> {
        await this.ready;
        return this.runtime.sendAgent(this.binding, id, message);
    }

    async discardWorktree(id: string): Promise<AgentTaskSnapshot> {
        await this.ready;
        return this.runtime.discardWorktree(this.sessionId, id);
    }

    hasRunning(): boolean {
        return this.runtime.hasRunning(this.sessionId);
    }

    getRunningSummary(): RunningTaskSummary {
        return this.runtime.getRunningSummary(this.sessionId);
    }

    async pendingNotifications(): Promise<readonly TaskNotification[]> {
        await this.ready;
        return this.runtime.pendingNotifications(this.sessionId);
    }

    async acknowledgeNotification(notification: Pick<TaskNotification, "taskId" | "notificationId">): Promise<void> {
        await this.ready;
        await this.runtime.acknowledgeNotification(this.sessionId, notification);
    }

    subscribe(listener: (event: TaskEventEnvelope) => void): () => void {
        return this.runtime.subscribe(this.sessionId, listener);
    }
}

class TaskRuntime implements TaskRuntimeLike {
    private readonly tasks = new Map<string, ManagedTask>();
    private readonly archived = new Map<string, TaskSnapshot>();
    private readonly sessionLoads = new Map<string, Promise<void>>();
    private readonly listeners = new Map<
        string,
        Set<(event: TaskEventEnvelope) => void>
    >();
    private readonly notifications = new TaskNotificationCenter();
    private readonly worktreeTasks: TaskWorktreeManager;
    private readonly pendingAgentStarts = new Map<string, number>();
    private pendingTaskStarts = 0;
    private sequence = 0;
    private closed = false;
    private closePromise: Promise<void> | undefined;

    constructor(
        private readonly shellRunner: ShellRunnerLike,
        private readonly createSubagentThread: CreateSubagentThread,
        private readonly journal: TaskJournalLike,
        worktrees: WorktreeRuntimeLike,
        private readonly subagents: SubagentRegistry,
        private readonly memory:MemoryRuntimeLike
    ) {
        this.worktreeTasks = new TaskWorktreeManager(worktrees);
    }

    ensureSession(sessionId: string): Promise<void> {
        let loading = this.sessionLoads.get(sessionId);
        if (loading) return loading;
        loading = this.restoreSession(sessionId);
        this.sessionLoads.set(sessionId, loading);
        return loading;
    }

    forSession(binding: TaskSessionBinding): TaskSessionLike {
        return new TaskSession(this, binding);
    }

    async startMemory(binding:TaskSessionBinding,input:StartMemoryTaskInput):Promise<MemoryTaskSnapshot|undefined> {
        this.assertOpen();
        if(!this.memory.enabled)return undefined;
        if(input.baseline)await this.memory.captureSource(binding.sessionId,input.baseline,input.signal);
        if([...this.tasks.values()].some(task=>isMemoryTask(task)&&task.status==="running"))return undefined;
        if((await this.memory.status()).pending===0)return undefined;
        this.assertOpen();
        if([...this.tasks.values()].some(task=>isMemoryTask(task)&&task.status==="running"))return undefined;
        const release=this.reserveTaskSlot();
        try{
            const task:ManagedMemoryTask={id:randomUUID(),kind:"memory",owner:{sessionId:binding.sessionId,turnId:input.turnId},status:"running",startedAt:new Date().toISOString(),
                store:binding.toolResultStore,controller:createTurnAbortController(),notificationPending:false,suppressTerminalNotification:!input.background,completion:Promise.resolve()};
            this.tasks.set(task.id,task);
            try{await this.publish("task_started",task,true);}catch(error){this.tasks.delete(task.id);throw error;}
            if(this.closed)task.controller.abort("shutdown");
            const signal=input.background?task.controller.signal:AbortSignal.any([task.controller.signal,input.signal]);
            task.completion=(async()=>{
                try {
                    const result = await this.memory.maintain({sessionId: binding.sessionId, signal});
                    const {pending} = await this.memory.status();
                    task.status = "completed";
                    task.resultPreview = result.status === "published" ? `Memory 已发布 ${result.topics} 个主题` :
                        result.status === "busy" ? "已有其他进程整理" : "本批来源已处理";
                    if (pending > 0) task.resultPreview += `；${pending} 个来源待后续维护`;
                }
                catch{task.status=signal.aborted?"cancelled":"failed";task.outputIssue="Memory 维护未完成，未消费的来源保留；用 /memory 查看状态";}
                finally{task.completedAt=new Date().toISOString();task.notificationPending=!task.suppressTerminalNotification;await this.publish("task_finished",task);}
            })();
            // All failures stay attached to this owned Task, including a terminal journal failure.
            void task.completion.catch(()=>{});
            if(!input.background){
                await task.completion;
                await this.markNotificationClaimed(binding.sessionId,task.id,taskNotificationId(task.id,1));
            }
            return snapshotMemory(task);
        }finally{release();}
    }

    async startShell(
        binding: TaskSessionBinding,
        input: StartShellTaskInput
    ): Promise<ShellTaskSnapshot> {
        this.assertOpen();
        if (input.waitMs !== undefined && (!Number.isInteger(input.waitMs) || input.waitMs < 100 || input.waitMs > 30_000)) throw new Error("等待时间必须在 100–30000ms 内");
        if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 600_000)) throw new Error("执行超时必须在 100–600000ms 内");
        input.signal?.throwIfAborted();
        const releaseSlot = this.reserveTaskSlot();
        try {
            const task = await createShellTask(binding, input);
            if (this.closed) {
                await task.store.removeTemporaryFile(task.outputPath);
                throw new Error("Task Runtime 已关闭");
            }
            this.tasks.set(task.id, task);
            try {
                await this.publish("task_started", task, true);
            } catch (error) {
                this.tasks.delete(task.id);
                await task.store.removeTemporaryFile(task.outputPath).catch(() => undefined);
                throw error;
            }
            const onAbort = () => task.controller.abort(input.signal?.reason);
            input.signal?.addEventListener("abort", onAbort, {once: true});
            if (input.signal?.aborted) onAbort();
            task.suppressTerminalNotification = true;
            task.completion = runShellTask(
                task,
                input,
                this.shellRunner,
                (finished) => this.publish("task_finished", finished)
            );
            let finishedDuringStartup: boolean;
            try {finishedDuringStartup = await observeShellStartup(task.completion, input.waitMs);}
            finally {input.signal?.removeEventListener("abort", onAbort);}
            if (!finishedDuringStartup) task.suppressTerminalNotification = false;
            let snapshot = await snapshotShell(task);
            if (snapshot.status !== "running") {
                // runShellTask sets the in-memory terminal state before it finishes
                // publishing task_finished. Wait for that publication so the claimed
                // notification can never be journaled ahead of the terminal event.
                await task.completion;
                snapshot = await snapshotShell(task);
                task.notificationPending = false;
                await this.markNotificationClaimed(binding.sessionId, task.id, taskNotificationId(task.id, 1));
            }
            return snapshot;
        } finally {
            releaseSlot();
        }
    }

    async startAgent(
        binding: TaskSessionBinding,
        input: StartAgentTaskInput
    ): Promise<AgentTaskSnapshot> {
        this.assertOpen();
        validateAgentTaskInput(input, this.subagents);
        const releaseTaskSlot = this.reserveTaskSlot();
        let releaseAgentSlot: (() => void) | undefined;
        try {
            releaseAgentSlot = this.reserveAgentSlot(binding.sessionId);
            const id = randomUUID();
            const prepared = await this.worktreeTasks.prepare(
                id,
                binding.sessionId,
                input,
                this.hasActiveWorktree(binding.sessionId)
            );
            if (this.closed) {
                await this.worktreeTasks.release(prepared.worktree);
                throw new Error("Task Runtime 已关闭");
            }
            const task = createAgentTask(
                id,
                binding,
                prepared.input,
                prepared.context,
                this.createSubagentThread,
                (progress) => this.publish("task_progress", progress),
                prepared.worktree,
            );
            this.tasks.set(id, task);
            try {
                await this.publish("task_started", task, true);
            } catch (error) {
                this.tasks.delete(id);
                await this.worktreeTasks.release(task.worktree);
                throw error;
            }
            task.completion = runAgentTask(
                task,
                prepared.input.request.prompt,
                this.worktreeTasks,
                (finished) => this.publish("task_finished", finished)
            );
            return snapshotAgent(task);
        } finally {
            releaseAgentSlot?.();
            releaseTaskSlot();
        }
    }

    async sendAgent(
        binding: TaskSessionBinding,
        id: string,
        message: string
    ): Promise<AgentTaskSnapshot> {
        this.assertOpen();
        let task = this.ownedTask(binding.sessionId, id);
        if (!task) {
            const archived = this.archived.get(id);
            if (archived?.owner.sessionId === binding.sessionId) {
                throw new Error(
                    archived.kind === "agent"
                        ? "该 Agent 仅有持久化状态，当前进程不能继续；请重新启动 Agent"
                        : `Task ${id} 不是 Agent`
                );
            }
            throw new Error(`Agent Task 不存在: ${id}`);
        }
        if (!isAgentTask(task)) throw new Error(`Task ${id} 不是 Agent`);
        if (task.worktree) {
            throw new Error("Worktree Agent 暂不支持发送消息或继续");
        }
        if (task.status === "cancelled") {
            throw new Error("已取消的 Agent 不能继续，请重新启动 Agent");
        }
        if (task.status === "running") {
            task.messageQueue.enqueueUser(message);
            await this.publish("task_progress", task);
            return snapshotAgent(task);
        }

        await task.completion;
        task = this.ownedTask(binding.sessionId, id);
        if (!task || !isAgentTask(task)) {
            throw new Error(`Agent Task 不存在: ${id}`);
        }
        if (task.status === "running") {
            task.messageQueue.enqueueUser(message);
            await this.publish("task_progress", task);
            return snapshotAgent(task);
        }
        if (task.status === "cancelled") {
            throw new Error("已取消的 Agent 不能继续，请重新启动 Agent");
        }
        if (this.runningAgentCount(binding.sessionId) >=
            MAX_RUNNING_AGENT_TASKS_PER_SESSION) {
            throw new Error(
                `当前 Session 同时运行的后台 Agent 已达到上限 ${MAX_RUNNING_AGENT_TASKS_PER_SESSION}`
            );
        }

        const previousNotification = task.notificationPending ? snapshotAgent(task) : undefined;
        if (previousNotification) this.notifications.rememberPrevious(previousNotification);
        const previous = {
            status: task.status,
            completedAt: task.completedAt,
            runCount: task.runCount,
            iterations: task.iterations,
            toolUseCount: task.toolUseCount,
            tokenCount: task.tokenCount,
            lastPublishedTokenCount: task.lastPublishedTokenCount,
            lastActivity: task.lastActivity,
            reason: task.reason,
            resultPreview: task.resultPreview,
            outputResult: task.outputResult,
            transcriptPath: task.transcriptPath,
            outputIssue: task.outputIssue,
            notificationPending: task.notificationPending,
            suppressTerminalNotification: task.suppressTerminalNotification,
        };
        try {
            task.messageQueue.enqueueUser(message);
        } catch (error) {
            if (previousNotification) this.notifications.acknowledgePrevious(taskNotificationId(task.id, task.runCount));
            throw error;
        }
        task.controller = createTurnAbortController();
        resetAgentRun(task, task.runCount + 1);
        task.status = "running";
        task.completedAt = undefined;
        task.notificationPending = false;
        task.suppressTerminalNotification = false;
        try {
            await this.publish("task_started", task, true);
        } catch (error) {
            if (previousNotification) this.notifications.acknowledgePrevious(taskNotificationId(task.id, previous.runCount));
            task.status = previous.status;
            task.completedAt = previous.completedAt;
            task.runCount = previous.runCount;
            task.iterations = previous.iterations;
            task.toolUseCount = previous.toolUseCount;
            task.tokenCount = previous.tokenCount;
            task.lastPublishedTokenCount = previous.lastPublishedTokenCount;
            task.lastActivity = previous.lastActivity;
            task.reason = previous.reason;
            task.resultPreview = previous.resultPreview;
            task.outputResult = previous.outputResult;
            task.transcriptPath = previous.transcriptPath;
            task.outputIssue = previous.outputIssue;
            task.notificationPending = previous.notificationPending;
            task.suppressTerminalNotification =
                previous.suppressTerminalNotification;
            throw error;
        }
        const queued = task.messageQueue.dequeueNextUserInput();
        if (!queued) throw new Error("Agent continuation 消息意外丢失");
        if (typeof queued.content !== "string") throw new Error("后台 Agent steering 只接受文本");
        task.completion = runAgentTask(
            task,
            queued.content,
            this.worktreeTasks,
            (finished) => this.publish("task_finished", finished)
        );
        return snapshotAgent(task);
    }

    async get(binding: TaskSessionBinding, id: string): Promise<TaskSnapshot | undefined> {
        const task = this.ownedTask(binding.sessionId, id);
        if (task) {
            if (isAgentTask(task)) await this.refreshManagedWorktree(task);
            return snapshotTask(task);
        }
        const archived = this.archived.get(id);
        if (archived?.owner.sessionId !== binding.sessionId) return undefined;
        return archived.kind === "agent"
            ? this.refreshArchivedWorktree(binding, archived)
            : archived;
    }

    async list(sessionId: string): Promise<readonly TaskSnapshot[]> {
        return Promise.all([
            ...[...this.tasks.values()]
                .filter((task) => task.owner.sessionId === sessionId)
                .map(snapshotTask),
            ...[...this.archived.values()]
                .filter((task) => task.owner.sessionId === sessionId)
                .map((task) => Promise.resolve(task)),
        ]);
    }

    async stop(sessionId: string, id: string, expectedKind?: TaskSnapshot["kind"]): Promise<TaskSnapshot | undefined> {
        const task = this.ownedTask(sessionId, id);
        if (!task) {
            const archived = this.archived.get(id);
            if (archived?.owner.sessionId !== sessionId) return undefined;
            if (expectedKind !== undefined && archived.kind !== expectedKind) {
                throw new Error(`任务类型不匹配: 预期 ${expectedKind}，实际 ${archived.kind}`);
            }
            await this.acknowledgeNotification(sessionId, {taskId: id,
                notificationId: taskNotificationId(id, archived.kind === "agent" ? archived.progress.runCount : 1)});
            return archived;
        }
        const kind = isMemoryTask(task)?"memory":isShellTask(task) ? "shell" : "agent";
        if (expectedKind !== undefined && kind !== expectedKind) {
            throw new Error(`任务类型不匹配: 预期 ${expectedKind}，实际 ${kind}`);
        }
        const shouldAcknowledge =
            task.status === "running" || task.notificationPending;
        if (task.status === "running") {
            task.suppressTerminalNotification = true;
            task.controller.abort("user-cancel");
            await task.completion;
        }
        if (shouldAcknowledge) {
            await this.markNotificationClaimed(sessionId, id, taskNotificationId(id, isAgentTask(task) ? task.runCount : 1));
        }
        task.notificationPending = false;
        return snapshotTask(task);
    }

    async discardWorktree(
        sessionId: string,
        taskId: string
    ): Promise<AgentTaskSnapshot> {
        const record = await this.getWorktreeRecord(sessionId, taskId);
        const lifecycle = await this.worktreeTasks.discard(record);
        return this.updateWorktree(
            sessionId,
            taskId,
            lifecycle.record,
            lifecycle.inspection
        );
    }

    hasRunning(sessionId?: string): boolean {
        return this.getRunningSummary(sessionId).total > 0;
    }

    getRunningSummary(sessionId?: string): RunningTaskSummary {
        let shell = 0;
        let agent = 0;
        let memory = 0;
        for (const task of this.tasks.values()) {
            if (
                task.status !== "running" ||
                (sessionId !== undefined && task.owner.sessionId !== sessionId)
            ) {
                continue;
            }
            if (isMemoryTask(task)) memory += 1;
            else if (isShellTask(task)) shell += 1;
            else agent += 1;
        }
        return {total: shell + agent + memory, shell, agent, memory};
    }

    pendingNotifications(sessionId: string): Promise<readonly TaskNotification[]> {
        return this.notifications.pending(
            sessionId,
            this.tasks.values(),
            this.archived.values(),
            snapshotTask
        );
    }

    async acknowledgeNotification(sessionId: string, notification: Pick<TaskNotification, "taskId" | "notificationId">): Promise<void> {
        if (this.notifications.hasPrevious(sessionId, notification.taskId, notification.notificationId)) {
            await this.markNotificationClaimed(sessionId, notification.taskId, notification.notificationId);
            this.notifications.acknowledgePrevious(notification.notificationId);
            return;
        }
        const task = this.ownedTask(sessionId, notification.taskId);
        const archived = this.archived.get(notification.taskId);
        if (!task && archived?.owner.sessionId !== sessionId) return;
        const runCount = task ? (isAgentTask(task) ? task.runCount : 1) : archived!.kind === "agent" ? archived!.progress.runCount : 1;
        if (taskNotificationId(notification.taskId, runCount) !== notification.notificationId) return;
        if (task ? !task.notificationPending : !this.notifications.hasArchivedPending(notification.taskId)) return;
        await this.markNotificationClaimed(sessionId, notification.taskId, notification.notificationId);
        if (task) {
            if (taskNotificationId(task.id, isAgentTask(task) ? task.runCount : 1) === notification.notificationId) task.notificationPending = false;
        } else this.notifications.acknowledgeArchived(notification.taskId);
    }

    subscribe(
        sessionId: string,
        listener: (event: TaskEventEnvelope) => void
    ): () => void {
        const listeners = this.listeners.get(sessionId) ??
            new Set<(event: TaskEventEnvelope) => void>();
        listeners.add(listener);
        this.listeners.set(sessionId, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.listeners.delete(sessionId);
        };
    }

    close(): Promise<void> {
        this.closePromise ??= (async () => {
            this.closed = true;
            const running = [...this.tasks.values()].filter(
                (task) => task.status === "running"
            );
            for (const task of running) task.controller.abort("shutdown");
            await Promise.allSettled(running.map((task) => task.completion));
        })();
        return this.closePromise;
    }

    private readonly markNotificationClaimed = async (
        sessionId: string,
        taskId: string,
        notificationId: string
    ): Promise<void> => {
        await this.journal.markNotificationClaimed({
            sequence: ++this.sequence,
            sessionId,
            taskId,
            notificationId,
        });
    };

    private assertOpen(): void {
        if (this.closed) throw new Error("Task Runtime 已关闭");
    }

    private ownedTask(sessionId: string, id: string): ManagedTask | undefined {
        const task = this.tasks.get(id);
        return task?.owner.sessionId === sessionId ? task : undefined;
    }

    private hasActiveWorktree(sessionId: string): boolean {
        return [...this.tasks.values()].some(
            (task) =>
                isAgentTask(task) &&
                task.owner.sessionId === sessionId &&
                task.status === "running" &&
                task.worktree?.state === "active"
        );
    }

    private runningAgentCount(sessionId: string): number {
        return [...this.tasks.values()].filter(
            (task) =>
                isAgentTask(task) &&
                task.owner.sessionId === sessionId &&
                task.status === "running"
        ).length;
    }

    private reserveTaskSlot(): () => void {
        if (
            this.tasks.size + this.archived.size + this.pendingTaskStarts >=
            MAX_TRACKED_TASKS
        ) {
            let evicted = false;
            for (const [id, task] of this.tasks) {
                if (task.status === "running" || task.notificationPending) continue;
                this.tasks.delete(id);
                evicted = true;
                break;
            }
            if (!evicted) {
                for (const [id] of this.archived) {
                    if (this.notifications.hasArchivedPending(id)) continue;
                    this.archived.delete(id);
                    evicted = true;
                    break;
                }
            }
            if (!evicted) {
                throw new Error(
                    `后台任务数量已达到上限 ${MAX_TRACKED_TASKS}，请先停止任务`
                );
            }
        }
        this.pendingTaskStarts += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.pendingTaskStarts -= 1;
        };
    }

    private reserveAgentSlot(sessionId: string): () => void {
        const pending = this.pendingAgentStarts.get(sessionId) ?? 0;
        if (
            this.runningAgentCount(sessionId) + pending >=
            MAX_RUNNING_AGENT_TASKS_PER_SESSION
        ) {
            throw new Error(
                `当前 Session 同时运行的后台 Agent 已达到上限 ${MAX_RUNNING_AGENT_TASKS_PER_SESSION}`
            );
        }
        this.pendingAgentStarts.set(sessionId, pending + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const remaining = (this.pendingAgentStarts.get(sessionId) ?? 1) - 1;
            if (remaining === 0) this.pendingAgentStarts.delete(sessionId);
            else this.pendingAgentStarts.set(sessionId, remaining);
        };
    }

    private async getWorktreeRecord(
        sessionId: string,
        taskId: string
    ): Promise<AgentWorktreeRecord> {
        const managed = this.ownedTask(sessionId, taskId);
        const agentTask = managed && isAgentTask(managed) ? managed : undefined;
        const archived = this.archived.get(taskId);
        const archivedAgent = archived?.kind === "agent" ? archived : undefined;
        return this.worktreeTasks.loadRecord(
            sessionId,
            taskId,
            agentTask,
            archivedAgent
        );
    }

    private async refreshManagedWorktree(task: ManagedAgentTask): Promise<void> {
        if (!task.worktree || task.worktree.state === "cleaned") return;
        task.worktreeDiffStat = undefined;
        task.worktreeDiffPreview = undefined;
        task.worktreeDiffResult = undefined;
        task.worktreeDiffRevision = undefined;
        try {
            const inspection = await this.worktreeTasks.refresh(task.worktree);
            task.worktreeInspection = inspection;
            if (!inspection) return;
            const captured = await this.worktreeTasks.captureDiff({
                record: task.worktree,
                inspection,
                store: task.store,
                toolCallId: task.owner.toolCallId,
            });
            task.worktreeDiffStat = captured?.stat;
            task.worktreeDiffRevision = captured?.revision;
            task.worktreeDiffPreview = captured?.preview;
            task.worktreeDiffResult = captured?.result;
        } catch (error) {
            appendTaskIssue(
                task,
                `Worktree 实时状态刷新失败：${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private async refreshArchivedWorktree(
        binding: TaskSessionBinding,
        task: AgentTaskSnapshot
    ): Promise<AgentTaskSnapshot> {
        if (!task.worktree || task.worktree.state === "cleaned") return task;
        const record = await this.worktreeTasks.loadRecord(
            binding.sessionId,
            task.id,
            undefined,
            task
        );
        const inspection = await this.worktreeTasks.refresh(record);
        if (!inspection) return task;
        let captured: Awaited<ReturnType<TaskWorktreeManager["captureDiff"]>>;
        let outputIssue = task.outputIssue;
        try {
            captured = await this.worktreeTasks.captureDiff({
                record,
                inspection,
                store: binding.toolResultStore,
                toolCallId: task.owner.toolCallId,
            });
        } catch (error) {
            const issue = `Worktree 实时 Diff 刷新失败：${
                error instanceof Error ? error.message : String(error)
            }`;
            outputIssue = [outputIssue, issue].filter(Boolean).join("；");
        }
        const updated: AgentTaskSnapshot = {
            ...task,
            worktree: worktreeSnapshot(record, inspection, captured?.revision),
            ...(captured
                ? {
                    worktreeDiffStat: captured.stat,
                    worktreeDiffPreview: captured.preview,
                    worktreeDiffResult: captured.result,
                }
                : {
                    worktreeDiffStat: undefined,
                    worktreeDiffPreview: undefined,
                    worktreeDiffResult: undefined,
                }),
            ...(outputIssue ? {outputIssue} : {}),
        };
        this.archived.set(task.id, updated);
        return updated;
    }

    private async updateWorktree(
        sessionId: string,
        taskId: string,
        record: AgentWorktreeRecord,
        inspection?: Awaited<ReturnType<TaskWorktreeManager["refresh"]>>
    ): Promise<AgentTaskSnapshot> {
        const managed = this.ownedTask(sessionId, taskId);
        if (managed && isAgentTask(managed)) {
            managed.worktree = record;
            managed.worktreeInspection = inspection;
            await this.publish("task_progress", managed);
            return snapshotAgent(managed);
        }
        const archived = this.archived.get(taskId);
        if (
            !archived ||
            archived.kind !== "agent" ||
            archived.owner.sessionId !== sessionId
        ) {
            throw new Error(`Agent Task 不存在: ${taskId}`);
        }
        const updated: AgentTaskSnapshot = {
            ...archived,
            worktree: worktreeSnapshot(record, inspection),
        };
        this.archived.set(taskId, updated);
        await this.publishArchived("task_progress", updated);
        return updated;
    }

    private async publish(
        type: TaskEventEnvelope["type"],
        task: ManagedTask,
        journalRequired = false
    ): Promise<void> {
        let event = this.createEvent(type, await snapshotTask(task));
        try {
            await this.journal.append(event);
        } catch (error) {
            if (journalRequired) throw error;
            appendTaskIssue(task, `Task Journal 写入失败：${
                error instanceof Error ? error.message : String(error)
            }`);
            event = {...event, task: await snapshotTask(task)};
        }
        this.notifyListeners(event);
    }

    private async publishArchived(
        type: TaskEventEnvelope["type"],
        task: TaskSnapshot
    ): Promise<void> {
        const event = this.createEvent(type, task);
        await this.journal.append(event);
        this.notifyListeners(event);
    }

    private createEvent(
        type: TaskEventEnvelope["type"],
        task: TaskSnapshot
    ): TaskEventEnvelope {
        return {
            version: 4,
            sequence: ++this.sequence,
            sessionId: task.owner.sessionId,
            task,
            type,
        };
    }

    private notifyListeners(event: TaskEventEnvelope): void {
        for (const listener of this.listeners.get(event.sessionId) ?? []) {
            try {
                listener(event);
            } catch {
                // 订阅者只消费状态；不能反向破坏 Task 生命周期。
            }
        }
    }

    private async restoreSession(sessionId: string): Promise<void> {
        const loaded = await this.journal.load(sessionId);
        this.sequence = Math.max(this.sequence, loaded.sequence);
        for (const snapshot of loaded.pendingRuns) {
            const current = loaded.tasks.find(task => task.id === snapshot.id);
            if (current?.kind === "agent" && snapshot.kind === "agent" && current.progress.runCount !== snapshot.progress.runCount) {
                this.notifications.rememberPrevious(snapshot);
            }
        }
        for (const snapshot of loaded.tasks) {
            if (this.tasks.has(snapshot.id) || this.archived.has(snapshot.id)) {
                continue;
            }
            let restored = snapshot;
            if (
                restored.kind === "agent" &&
                restored.progress.pendingMessages > 0
            ) {
                restored = {
                    ...restored,
                    progress: {
                        ...restored.progress,
                        pendingMessages: 0,
                    },
                    outputIssue: [
                        restored.outputIssue,
                        "上次进程中的 Agent 消息正文未持久化，待处理消息已丢弃",
                    ].filter(Boolean).join("；"),
                };
            }
            if (snapshot.status === "running") {
                const reconciliation = snapshot.kind === "agent"
                    ? await this.worktreeTasks.reconcileInterrupted(snapshot)
                    : {};
                restored = {
                    ...restored,
                    status: "cancelled",
                    completedAt: new Date().toISOString(),
                    outputIssue: [
                        restored.outputIssue,
                        "上次 Pillar 进程结束或崩溃，任务不会自动重跑",
                        reconciliation.issue,
                    ].filter(Boolean).join("；"),
                    ...(reconciliation.worktree
                        ? {worktree: reconciliation.worktree}
                        : {}),
                };
                await this.journal.append(
                    this.createEvent("task_finished", restored)
                );
            }
            this.archived.set(restored.id, restored);
            this.notifications.rememberArchived(
                restored.id,
                loaded.claimedNotificationIds.has(taskNotificationId(restored.id, restored.kind === "agent" ? restored.progress.runCount : 1)) ||
                (restored.kind === "shell" && isExpectedShellShutdown(restored))
            );
        }
    }
}

export function createTaskRuntime(
    storage: PillarStorageLayout,
    cwd: string,
    childEnvironment: ChildProcessEnvironment,
    shellRunner: ShellRunnerLike,
    createSubagentThread: CreateSubagentThread,
    subagents: SubagentRegistry,
    memory:MemoryRuntimeLike
): TaskRuntimeLike {
    return new TaskRuntime(
        shellRunner,
        createSubagentThread,
        createTaskJournal(storage, cwd),
        createWorktreeRuntime(storage, cwd, childEnvironment),
        subagents,
        memory
    );
}
