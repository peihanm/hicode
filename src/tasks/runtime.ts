import type {AgentMessaging} from "../runtime/agentMessaging.js";
import type {MemoryRuntimeLike} from "../memory/runtime.js";
import {isMemoryTask,isAgentTask,snapshotMemory,type ManagedMemoryTask} from "./managed.js";
import type {StartMemoryTaskInput,MemoryTaskSnapshot} from "./types.js";
import {randomUUID} from "node:crypto";
import {createTurnAbortController} from "../runtime/abort.js";
import type {ShellRunnerLike} from "../tools/bash/shellRunner.js";
import type {CreateSubagentThread} from "../subagents/types.js";
import type {SubagentRegistry} from "../subagents/registry.js";
import type {HiCodeStorageLayout} from "../persistence/index.js";
import {createTaskJournal, type TaskJournalLike} from "./journal.js";
import {
    appendTaskIssue,
    isShellTask,
    type ManagedTask,
    snapshotAgent,
    snapshotShell,
    snapshotTask,
} from "./managed.js";
import {TaskNotificationCenter, taskNotificationId, isExpectedShellShutdown} from "./notifications.js";
import {createShellTask, runShellTask} from "./shellTask.js";
import {
    createAgentTask,
    resetAgentRun,
    runAgentTask,
    validateAgentTaskInput,
} from "./agentTask.js";
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
    readonly messaging?: AgentMessaging;
    private readonly ready: Promise<void>;

    constructor(
        private readonly runtime: TaskRuntime,
        private readonly binding: TaskSessionBinding
    ) {
        this.sessionId = binding.sessionId;
        this.ready = runtime.ensureSession(binding.sessionId);
        if (binding.messageQueue) this.messaging = {
            send: async (target, message) => {
                await this.ready;
                return runtime.messageAgent(binding.sessionId, target, message);
            },
            wait: (timeoutMs, signal) => binding.messageQueue!.waitForAgentMessage(timeoutMs, signal),
        };
    }

    initialize(): Promise<void> {
        return this.ready;
    }

    async startShell(input: StartShellTaskInput): Promise<ShellTaskSnapshot> {
        if (this.binding.allowBackgroundTasks === false) {
            throw new Error("This execution mode does not support background tasks");
        }
        await this.ready;
        return this.runtime.startShell(this.binding, input);
    }

    async startAgent(input: StartAgentTaskInput): Promise<AgentTaskSnapshot> {
        if (this.binding.allowBackgroundTasks === false) {
            throw new Error("This execution mode does not support background tasks");
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

    async stop(id: string): Promise<TaskSnapshot | undefined> {
        await this.ready;
        return this.runtime.stop(this.sessionId, id);
    }

    async followup(id: string, message: string): Promise<AgentTaskSnapshot> {
        await this.ready;
        return this.runtime.followupAgent(this.binding, id, message);
    }

    async interrupt(id: string): Promise<AgentTaskSnapshot> {
        await this.ready;
        return this.runtime.interruptAgent(this.sessionId, id);
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
    private readonly pendingAgentStarts = new Map<string, number>();
    private pendingTaskStarts = 0;
    private sequence = 0;
    private closed = false;
    private closePromise: Promise<void> | undefined;

    constructor(
        private readonly shellRunner: ShellRunnerLike,
        private readonly createSubagentThread: CreateSubagentThread,
        private readonly journal: TaskJournalLike,
        private readonly subagents: SubagentRegistry,
        private readonly memory:MemoryRuntimeLike
    ) {
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
            if (this.closed) task.controller.abort("shutdown");
            const signal=input.background?task.controller.signal:AbortSignal.any([task.controller.signal,input.signal]);
            task.completion=(async()=>{
                try {
                    const result = await this.memory.maintain({sessionId: binding.sessionId, signal});
                    const {pending} = await this.memory.status();
                    task.status = "completed";
                    task.resultPreview = result.status === "published" ? `Memory published ${result.topics} topics` :
                        result.status === "busy" ? "Another process is consolidating" : "Sources in this batch already processed";
                    if (pending > 0) task.resultPreview += `;${pending} sources await later maintenance`;
                }
                catch{task.status=signal.aborted?"cancelled":"failed";task.outputIssue="Memory maintenance is incomplete; unconsumed sources are retained. Use /memory for status.";}
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
        if (input.waitMs !== undefined && (!Number.isInteger(input.waitMs) || input.waitMs < 100 || input.waitMs > 30_000)) throw new Error("Wait time must be 100–30000ms");
        if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 600_000)) throw new Error("Execution timeout must be 100–600000ms");
        input.signal?.throwIfAborted();
        const releaseSlot = this.reserveTaskSlot();
        try {
            const task = await createShellTask(binding, input);
            if (this.closed) {
                await task.store.removeTemporaryFile(task.outputPath);
                throw new Error("Task Runtime is closed");
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
            const task = createAgentTask(
                id,
                binding,
                input,
                input.parentContext,
                this.createSubagentThread,
                async (progress) => { this.notifyListeners(this.createEvent("task_progress", await snapshotTask(progress))); },
            );
            this.tasks.set(id, task);
            releaseAgentSlot();
            releaseTaskSlot();
            const started = this.publish("task_started", task, true);
            task.completion = started.then(() => runAgentTask(task, input.request.prompt,
                finished => this.publish("task_finished", finished)));
            void task.completion.catch(() => {});
            try {await started;}
            catch (error) {this.tasks.delete(id); throw error;}
            return snapshotAgent(task);
        } finally {
            releaseAgentSlot?.();
            releaseTaskSlot();
        }
    }

    async messageAgent(sessionId: string, id: string, message: string): Promise<{messageId: string}> {
        this.assertOpen();
        const task = this.ownedTask(sessionId, id);
        if (!task || !isAgentTask(task)) throw new Error(`Live-session Agent not found: ${id}`);
        if (task.stopRequested || task.status === "cancelled") throw new Error("A stopped Agent cannot receive messages");
        const queued = task.messageQueue.enqueueAgent(message, {sender: "parent", recipient: id, runCount: task.runCount, intent: "message"});
        await this.publish("task_progress", task);
        return {messageId: queued.id};
    }

    async followupAgent(binding: TaskSessionBinding, id: string, message: string): Promise<AgentTaskSnapshot> {
        this.assertOpen();
        const task = this.ownedTask(binding.sessionId, id);
        if (!task) throw new Error(`Live-session Agent not found: ${id}; persisted state cannot continue in this process`);
        if (!isAgentTask(task)) throw new Error(`Task ${id} is not an Agent`);
        const assertAvailable = () => {
            this.assertOpen();
            if (task.stopRequested || task.status === "cancelled") throw new Error("A cancelled Agent cannot continue; start a new Agent");
        };
        const enqueue = async () => {
            task.messageQueue.enqueueAgent(message, {sender: "parent", recipient: id, runCount: task.runCount, intent: "followup"});
            await this.publish("task_progress", task);
            return snapshotAgent(task);
        };
        assertAvailable();
        if (task.status === "running" && !task.controller.signal.aborted) return enqueue();
        await task.completion;
        assertAvailable();
        if (task.status === "running") return enqueue();
        if (!message.trim() || Buffer.byteLength(message, "utf8") > 32 * 1024) throw new Error("Follow-up must contain 1–32768 bytes of text");
        if (this.runningAgentCount(binding.sessionId) >= MAX_RUNNING_AGENT_TASKS_PER_SESSION) {
            throw new Error(`Concurrent background Agents in this Session reached the limit: ${MAX_RUNNING_AGENT_TASKS_PER_SESSION}`);
        }
        const previousNotification = task.notificationPending ? snapshotAgent(task) : undefined;
        if (previousNotification) this.notifications.rememberPrevious(previousNotification);
        // Reserve the run and its completion promise before yielding to persistence or another caller.
        task.controller = createTurnAbortController();
        resetAgentRun(task, task.runCount + 1);
        task.status = "running";
        task.completedAt = undefined;
        task.notificationPending = false;
        task.suppressTerminalNotification = false;
        const started = this.publish("task_started", task, true);
        task.completion = started.then(
            () => runAgentTask(task, message, finished => this.publish("task_finished", finished)),
            async error => {
                task.status = task.stopRequested ? "cancelled" : task.interruptRequested ? "interrupted" : "failed";
                task.completedAt = new Date().toISOString();
                task.outputIssue = error instanceof Error ? error.message : String(error);
                task.notificationPending = !task.suppressTerminalNotification;
                await this.publish("task_finished", task);
            },
        );
        void task.completion.catch(() => {});
        await started;
        return snapshotAgent(task);
    }

    async get(binding: TaskSessionBinding, id: string): Promise<TaskSnapshot | undefined> {
        const task = this.ownedTask(binding.sessionId, id);
        if (task) {
            return snapshotTask(task);
        }
        const archived = this.archived.get(id);
        if (archived?.owner.sessionId !== binding.sessionId) return undefined;
        return archived;
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

    async interruptAgent(sessionId: string, id: string): Promise<AgentTaskSnapshot> {
        this.assertOpen();
        const task = this.ownedTask(sessionId, id);
        if (!task || !isAgentTask(task)) throw new Error("Only a live-session Agent can be interrupted");
        if (!task.stopRequested && task.status === "running" && !task.controller.signal.aborted) {
            task.interruptRequested = true;
            task.controller.abort("user-cancel");
        }
        await task.completion;
        return snapshotAgent(task);
    }

    async stop(sessionId: string, id: string): Promise<TaskSnapshot | undefined> {
        const task = this.ownedTask(sessionId, id);
        if (!task) {
            const archived = this.archived.get(id);
            if (archived?.owner.sessionId !== sessionId) return undefined;
            await this.acknowledgeNotification(sessionId, {taskId: id,
                notificationId: taskNotificationId(id, archived.kind === "agent" ? archived.progress.runCount : 1)});
            return archived;
        }
        if (isAgentTask(task)) task.stopRequested = true;
        const shouldAcknowledge =
            task.status === "running" || task.notificationPending;
        if (task.status === "running") {
            task.suppressTerminalNotification = true;
            if (isAgentTask(task)) task.interruptRequested = false;
            task.controller.abort("user-cancel");
            await task.completion;
        }
        if (isAgentTask(task) && task.status !== "cancelled") {
            task.interruptRequested = false;
            task.status = "cancelled";
            task.completedAt = new Date().toISOString();
            task.suppressTerminalNotification = true;
            await this.publish("task_finished", task);
        }
        if (shouldAcknowledge) {
            await this.markNotificationClaimed(sessionId, id, taskNotificationId(id, isAgentTask(task) ? task.runCount : 1));
        }
        task.notificationPending = false;
        return snapshotTask(task);
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
            for (const task of running) {
                if (isAgentTask(task)) {task.stopRequested = true; task.interruptRequested = false;}
                task.controller.abort("shutdown");
            }
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
        if (this.closed) throw new Error("Task Runtime is closed");
    }

    private ownedTask(sessionId: string, id: string): ManagedTask | undefined {
        const task = this.tasks.get(id);
        return task?.owner.sessionId === sessionId ? task : undefined;
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
                    `Background task limit reached: ${MAX_TRACKED_TASKS}; stop a task first`
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
                `Concurrent background Agents in this Session reached the limit: ${MAX_RUNNING_AGENT_TASKS_PER_SESSION}`
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
            appendTaskIssue(task, `Task Journal write failed: ${
                error instanceof Error ? error.message : String(error)
            }`);
            event = {...event, task: await snapshotTask(task)};
        }
        this.notifyListeners(event);
    }

    private createEvent(
        type: TaskEventEnvelope["type"],
        task: TaskSnapshot
    ): TaskEventEnvelope {
        return {
            version: 5,
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
                // Subscribers only consume state; they cannot disrupt the Task lifecycle.
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
                        "Agent message contents from the previous process were not persisted; pending messages were discarded",
                    ].filter(Boolean).join(";"),
                };
            }
            if (snapshot.status === "running") {
                restored = {
                    ...restored,
                    status: "cancelled",
                    completedAt: new Date().toISOString(),
                    outputIssue: [
                        restored.outputIssue,
                        "The previous HiCode process exited or crashed; tasks will not restart automatically",
                    ].filter(Boolean).join(";"),
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
    storage: HiCodeStorageLayout,
    cwd: string,
    shellRunner: ShellRunnerLike,
    createSubagentThread: CreateSubagentThread,
    subagents: SubagentRegistry,
    memory:MemoryRuntimeLike
): TaskRuntimeLike {
    return new TaskRuntime(
        shellRunner,
        createSubagentThread,
        createTaskJournal(storage, cwd),
        subagents,
        memory
    );
}
