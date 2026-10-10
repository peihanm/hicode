import type {ChildShellSession} from "./childAccess.js";
import {runReviewTask, type TaskReviewRunner} from "./review.js";
import {runMemoryTask} from "./memoryTask.js";
import type {StartTaskReviewInput, TaskReviewSnapshot} from "./types.js";
import {isReviewTask, snapshotReview, type ManagedReviewTask} from "./managed.js";
import type {AgentMessaging} from "../runtime/agentMessaging.js";
import type {MemoryRuntimeLike} from "../memory/runtime.js";
import {isMemoryTask,isAgentTask,snapshotMemory,type ManagedMemoryTask} from "./managed.js";
import type {StartMemoryTaskInput,MemoryTaskSnapshot} from "./types.js";
import {randomBytes} from "node:crypto";
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
    readShellOutputChunk,
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
    AgentFollowupResult,
    ShellTaskSnapshot,
    StartAgentTaskInput,
    StartShellTaskInput,
    RunShellTaskInput,
    RunShellTaskResult,
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

type ScopedTaskBinding = TaskSessionBinding & {signal: AbortSignal};

class TaskSession implements TaskSessionLike {
    private readonly binding: ScopedTaskBinding;
    readonly sessionId: string;
    readonly messaging?: AgentMessaging;
    private readonly ready: Promise<void>;
    private readonly children = new Set<TaskSession>();
    private readonly starts = new Set<Promise<unknown>>();
    private readonly controller = createTurnAbortController();
    private closePromise?: Promise<void>;

    private assertOpen(): void {
        if (this.controller.signal.aborted) throw new Error("Task Session is closed");
    }

    close(): Promise<void> {
        return this.closePromise ??= (async () => {
            this.controller.abort("shutdown");
            await this.ready;
            const stopped = await Promise.allSettled((await this.list())
                .filter(task => task.status === "running" || task.kind === "agent")
                .map(task => this.stop(task.id)));
            await Promise.allSettled([...this.starts]);
            const children = await Promise.allSettled([...this.children].map(child => child.close()));
            const failures = [...stopped, ...children].flatMap(result => result.status === "rejected" ? [result.reason] : []);
            if (failures.length) throw new AggregateError(failures, "Task Session cleanup failed");
        })();
    }

    private trackStart<T>(operation: () => Promise<T>): Promise<T> {
        const pending = operation();
        this.starts.add(pending);
        return pending.finally(() => this.starts.delete(pending));
    }

    constructor(
        private readonly runtime: TaskRuntime,
        binding: TaskSessionBinding
    ) {
        this.binding = {...binding, signal: this.controller.signal};
        this.sessionId = binding.sessionId;
        this.ready = runtime.ensureSession(binding.sessionId);
        if (binding.messageQueue) this.messaging = {
            send: async (target, message) => {
                await this.ready;
                return runtime.messageAgent(binding.sessionId, target, message);
            },
            wait: signal => binding.messageQueue!.createAgentInputChannel(() => {}).waitForInput(signal),
        };
    }

    createChildShellSession(store: TaskSessionBinding["toolResultStore"]): ChildShellSession {
        this.assertOpen();
        if (store.sessionId === this.sessionId) throw new Error("Child Shell requires an independent Session");
        const child = new TaskSession(this.runtime, {
            sessionId: store.sessionId, toolResultStore: store,
            allowBackgroundTasks: this.binding.allowBackgroundTasks,
            shellContinuation: this.binding.shellContinuation,
        });
        this.children.add(child);
        return {close: async () => {try {await child.close();} finally {this.children.delete(child);}}, tasks: {
            sessionId: child.sessionId,
            get shellContinuation() {return child.shellContinuation;},
            startShell: input => child.startShell(input),
            runShell: input => child.runShell(input),
            get: id => child.get(id),
            readShellOutput: (id, afterBytes) => child.readShellOutput(id, afterBytes),
            list: () => child.list(),
            stop: id => child.stop(id),
            subscribe: listener => child.subscribe(listener),
            acknowledgeNotification: notification => child.acknowledgeNotification(notification),
        }};
    }

    initialize(): Promise<void> {
        return this.ready;
    }
    get shellContinuation(): boolean {return this.binding.shellContinuation ?? this.binding.allowBackgroundTasks !== false;}

    async startShell(input: StartShellTaskInput): Promise<ShellTaskSnapshot> {
        if (this.binding.allowBackgroundTasks === false) {
            throw new Error("This execution mode does not support background tasks");
        }
        await this.ready;
        this.assertOpen();
        return this.trackStart(async () => {
            const task = await this.runtime.startShell(this.binding, input);
            if (this.controller.signal.aborted) {
                await this.runtime.stop(this.sessionId, task.id);
                throw new Error("Task Session closed during Shell startup");
            }
            return task;
        });
    }

    async runShell(input: RunShellTaskInput): Promise<RunShellTaskResult> {
        if (!this.shellContinuation) throw new Error("This execution mode requires one-shot Shell execution");
        await this.ready;
        this.assertOpen();
        return this.trackStart(() => this.runtime.runShell(this.binding,
            {...input, signal: AbortSignal.any([input.signal, this.controller.signal])}));
    }

    async startAgent(input: StartAgentTaskInput): Promise<AgentTaskSnapshot> {
        if (this.binding.allowBackgroundTasks === false) {
            throw new Error("This execution mode does not support background tasks");
        }
        await this.ready;
        this.assertOpen();
        return this.trackStart(() => this.runtime.startAgent(this.binding, input));
    }

    async startMemory(input:StartMemoryTaskInput):Promise<MemoryTaskSnapshot|undefined> {
        if(input.background&&this.binding.allowBackgroundTasks===false)return undefined;
        await this.ready;this.assertOpen();return this.trackStart(() => this.runtime.startMemory(this.binding, input));
    }

    async startReview(input: StartTaskReviewInput): Promise<TaskReviewSnapshot> {
        await this.ready;
        this.assertOpen();
        return this.trackStart(() => this.runtime.startReview(this.binding, {...input, signal: AbortSignal.any([input.signal, this.controller.signal])}));
    }

    async get(id: string): Promise<TaskSnapshot | undefined> {
        await this.ready;
        return this.runtime.get(this.binding, id);
    }

    async readShellOutput(id: string, afterBytes: number): ReturnType<TaskSessionLike["readShellOutput"]> {
        await this.ready;
        return this.runtime.readShellOutput(this.sessionId, id, afterBytes);
    }

    async list(): Promise<readonly TaskSnapshot[]> {
        await this.ready;
        return this.runtime.list(this.sessionId);
    }

    async stop(id: string): Promise<TaskSnapshot | undefined> {
        await this.ready;
        return this.runtime.stop(this.sessionId, id);
    }

    async followup(id: string, message: string): Promise<AgentFollowupResult> {
        await this.ready;
        this.assertOpen();
        return this.trackStart(() => this.runtime.followupAgent(this.binding, id, message));
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
    private readonly issuedIds = new Set<string>();
    private allocateId(): string {
        let id: string;
        do {id = `t_${randomBytes(6).toString("hex")}`;} while (this.issuedIds.has(id) || this.archived.has(id));
        this.issuedIds.add(id);
        return id;
    }

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
    private readonly starts = new Set<Promise<unknown>>();
    private sequence = 0;
    private closed = false;
    private closePromise: Promise<void> | undefined;

    constructor(
        private readonly shellRunner: ShellRunnerLike,
        private readonly createSubagentThread: CreateSubagentThread,
        private readonly journal: TaskJournalLike,
        private readonly subagents: SubagentRegistry,
        private readonly memory:MemoryRuntimeLike,
        private readonly reviewTask: TaskReviewRunner
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

    private trackStart<T>(operation: () => Promise<T>): Promise<T> {
        this.assertOpen();
        const started = Promise.resolve().then(operation);
        this.starts.add(started);
        return started.finally(() => this.starts.delete(started));
    }

    startMemory(binding: ScopedTaskBinding, input: StartMemoryTaskInput): Promise<MemoryTaskSnapshot | undefined> {
        return this.trackStart(() => this.startMemoryOwned(binding, input));
    }
    startShell(binding: ScopedTaskBinding, input: StartShellTaskInput): Promise<ShellTaskSnapshot> {
        return this.trackStart(async () => {
            const result = await this.startShellOwned(binding, input);
            if (result.kind !== "task") throw new Error("Background Shell did not create a Task");
            return result.task;
        });
    }
    runShell(binding: ScopedTaskBinding, input: RunShellTaskInput): Promise<RunShellTaskResult> {
        return this.trackStart(() => this.startShellOwned(binding, input, input));
    }
    startAgent(binding: ScopedTaskBinding, input: StartAgentTaskInput): Promise<AgentTaskSnapshot> {
        return this.trackStart(() => this.startAgentOwned(binding, input));
    }

    startReview(binding: ScopedTaskBinding, input: StartTaskReviewInput): Promise<TaskReviewSnapshot> {
        const evidence = Object.freeze({...input.evidence});
        return this.trackStart(async () => {
            this.assertOpen();
            binding.signal.throwIfAborted();
            const {parentContext} = input;
            if (parentContext.sessionId !== binding.sessionId || input.signal.aborted || parentContext.signal.aborted) {
                throw new Error("Task review owner is unavailable");
            }
            if (!Number.isSafeInteger(evidence.fromRound) || !Number.isSafeInteger(evidence.toRound) || evidence.fromRound < 1 ||
                evidence.toRound !== evidence.fromRound + 9 || evidence.requirements.length > 17_000 || evidence.activity.length > 24_000) {
                throw new Error("Invalid frozen task review evidence");
            }
            if ([...this.tasks.values()].some(task => isReviewTask(task) && task.owner.sessionId === binding.sessionId && task.status === "running")) {
                throw new Error("A background task review is already running in this Session");
            }
            const release = this.reserveTaskSlot();
            let releaseAgent: () => void;
            try {releaseAgent = this.reserveAgentSlot(binding.sessionId);}
            catch (error) {release(); throw error;}
            const task: ManagedReviewTask = {
                id: this.allocateId(), kind: "review", owner: {sessionId: binding.sessionId, turnId: parentContext.turnId},
                status: "running", startedAt: new Date().toISOString(), fromRound: evidence.fromRound, toRound: evidence.toRound,
                store: binding.toolResultStore, controller: createTurnAbortController(), completion: Promise.resolve(),
                notificationPending: false, suppressTerminalNotification: true,
            };
            this.tasks.set(task.id, task);
            releaseAgent();
            try {
                await this.publish("task_started", task, true);
            } catch (error) {
                this.tasks.delete(task.id);
                release();
                throw error;
            }
            release();
            if (this.closed) task.controller.abort("shutdown");
            task.completion = runReviewTask(task, {...input, evidence}, this.reviewTask,
                finished => this.publish("task_finished", finished));
            await task.completion;
            return snapshotReview(task);
        });
    }

    private async startMemoryOwned(binding:ScopedTaskBinding,input:StartMemoryTaskInput):Promise<MemoryTaskSnapshot|undefined> {
        this.assertOpen();
        binding.signal.throwIfAborted();
        if(!this.memory.enabled)return undefined;
        if(input.baseline)await this.memory.captureSource(binding.sessionId,input.baseline,AbortSignal.any([binding.signal,input.signal]));
        if([...this.tasks.values()].some(task=>isMemoryTask(task)&&task.status==="running"))return undefined;
        if((await this.memory.status()).pending===0)return undefined;
        this.assertOpen();
        binding.signal.throwIfAborted();
        if([...this.tasks.values()].some(task=>isMemoryTask(task)&&task.status==="running"))return undefined;
        const release=this.reserveTaskSlot();
        try{
            const task:ManagedMemoryTask={id:this.allocateId(),kind:"memory",owner:{sessionId:binding.sessionId,turnId:input.turnId},status:"running",startedAt:new Date().toISOString(),
                store:binding.toolResultStore,controller:createTurnAbortController(),notificationPending:false,suppressTerminalNotification:!input.background,completion:Promise.resolve()};
            this.tasks.set(task.id,task);
            try{await this.publish("task_started",task,true);}catch(error){this.tasks.delete(task.id);throw error;}
            if (this.closed) task.controller.abort("shutdown");
            const signal=AbortSignal.any([task.controller.signal,binding.signal,...(input.background?[]:[input.signal])]);
            task.completion = runMemoryTask(task, this.memory, signal,
                finished => this.publish("task_finished", finished));
            // All failures stay attached to this owned Task, including a terminal journal failure.
            void task.completion.catch(()=>{});
            if(!input.background || binding.signal.aborted){
                await task.completion;
                await this.markNotificationClaimed(binding.sessionId,task.id,taskNotificationId(task.id,1));
            }
            return snapshotMemory(task);
        }finally{release();}
    }

    private async startShellOwned(
        binding: ScopedTaskBinding,
        input: StartShellTaskInput,
        continuation?: RunShellTaskInput
    ): Promise<RunShellTaskResult> {
        this.assertOpen();
        binding.signal.throwIfAborted();
        if (continuation && (!Number.isInteger(continuation.waitMs) || continuation.waitMs < 100 || continuation.waitMs > 30_000)) throw new Error("Wait time must be 100–30000ms");
        if (continuation?.timeoutMs !== undefined && (!Number.isInteger(continuation.timeoutMs) || continuation.timeoutMs < 100 || continuation.timeoutMs > 600_000)) throw new Error("Execution timeout must be 100–600000ms");
        continuation?.signal.throwIfAborted();
        const releaseSlot = this.reserveTaskSlot();
        try {
            const task = await createShellTask(this.allocateId(), binding, input);
            if (this.closed || binding.signal.aborted) {
                await task.store.removeTemporaryFile(task.outputPath);
                throw new Error("Task Runtime is closed");
            }
            this.tasks.set(task.id, task);
            if (!continuation) {
                task.published = true;
                task.publication = this.publish("task_started", task, true);
                try {await task.publication;}
                catch (error) {
                    this.tasks.delete(task.id);
                    await task.store.removeTemporaryFile(task.outputPath).catch(() => undefined);
                    throw error;
                }
            }
            const onAbort = () => task.controller.abort(continuation?.signal.reason);
            continuation?.signal.addEventListener("abort", onAbort, {once: true});
            if (continuation?.signal.aborted) onAbort();
            task.suppressTerminalNotification = true;
            task.completion = runShellTask(
                task,
                input,
                this.shellRunner,
                {timeoutMs: continuation?.timeoutMs ?? null, onPhaseChanged: () => {
                        if (task.published) void snapshotShell(task).then(snapshot => {
                            if (task.status === "running" && task.phase === snapshot.phase) {
                                this.notifyListeners(this.createEvent("task_progress", snapshot));
                            }
                        }).catch(error => appendTaskIssue(task, `Task progress unavailable: ${String(error)}`));
                    }},
                async finished => {
                    if (!finished.published) return;
                    await finished.publication;
                    await this.publish("task_finished", finished);
                }
            );
            void task.completion.catch(() => {});
            let publicationAccepted = !continuation;
            try {
                const finished = await observeShellStartup(task.completion, continuation?.waitMs);
                if (continuation && (finished || task.status !== "running")) {
                    await task.completion;
                    this.tasks.delete(task.id);
                    if (!task.inlineResult) throw new Error("Completed Shell is missing its execution result");
                    return {kind: "inline", result: task.inlineResult,
                        ...(task.outputResult ? {persisted: task.outputResult} : {}),
                        ...(task.outputIssue ? {outputIssue: task.outputIssue} : {})};
                }
                if (continuation) {
                    continuation.signal.throwIfAborted();
                    task.published = true;
                    task.inlineResult = undefined;
                    task.publication = this.publish("task_started", task, true);
                    await task.publication;
                    publicationAccepted = true;
                }
                let snapshot = await snapshotShell(task);
                if (task.status !== "running") {
                    await task.completion;
                    snapshot = await snapshotShell(task);
                    task.suppressTerminalNotification = false;
                    task.notificationPending = !isExpectedShellShutdown(task);
                } else {
                    continuation?.signal.throwIfAborted();
                    continuation?.onHandoff();
                    task.suppressTerminalNotification = false;
                }
                return {kind: "task", task: snapshot};
            } catch (error) {
                task.controller.abort("shutdown");
                await task.completion.catch(() => {});
                if (!publicationAccepted) this.tasks.delete(task.id);
                throw error;
            } finally {
                continuation?.signal.removeEventListener("abort", onAbort);
            }
        } finally {
            releaseSlot();
        }
    }

    private async startAgentOwned(
        binding: ScopedTaskBinding,
        input: StartAgentTaskInput
    ): Promise<AgentTaskSnapshot> {
        this.assertOpen();
        binding.signal.throwIfAborted();
        validateAgentTaskInput(input, this.subagents);
        const releaseTaskSlot = this.reserveTaskSlot(true);
        let releaseAgentSlot: (() => void) | undefined;
        try {
            releaseAgentSlot = this.reserveAgentSlot(binding.sessionId);
            const id = this.allocateId();
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
            catch (error) {this.tasks.delete(id); await task.thread.close(); throw error;}
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

    async followupAgent(binding: ScopedTaskBinding, id: string, message: string): Promise<AgentFollowupResult> {
        this.assertOpen();
        const task = this.ownedTask(binding.sessionId, id);
        if (!task) throw new Error(`Live-session Agent not found: ${id}; persisted state cannot continue in this process`);
        if (!isAgentTask(task)) throw new Error(`Task ${id} is not an Agent`);
        const assertAvailable = () => {
            this.assertOpen();
            binding.signal.throwIfAborted();
            if (task.stopRequested || task.status === "cancelled") throw new Error("A cancelled Agent cannot continue; start a new Agent");
        };
        const enqueue = async (): Promise<AgentFollowupResult> => {
            task.messageQueue.enqueueAgent(message, {sender: "parent", recipient: id, runCount: task.runCount, intent: "followup"});
            await this.publish("task_progress", task);
            return {task: snapshotAgent(task), delivery: "queued"};
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
        return {task: snapshotAgent(task), delivery: "started"};
    }

    async get(binding: TaskSessionBinding, id: string): Promise<TaskSnapshot | undefined> {
        const task = this.ownedTask(binding.sessionId, id);
        if (task && (!isShellTask(task) || task.published)) {
            return snapshotTask(task);
        }
        const archived = this.archived.get(id);
        if (archived?.owner.sessionId !== binding.sessionId) return undefined;
        return archived;
    }

    async readShellOutput(sessionId: string, id: string, afterBytes: number): ReturnType<TaskSessionLike["readShellOutput"]> {
        if (!Number.isSafeInteger(afterBytes) || afterBytes < 0) throw new Error("Invalid Shell output cursor");
        const task = this.ownedTask(sessionId, id);
        if (!task || !isShellTask(task) || !task.published || task.status !== "running") return undefined;
        return readShellOutputChunk(task.outputPath, afterBytes);
    }

    async list(sessionId: string): Promise<readonly TaskSnapshot[]> {
        return Promise.all([
            ...[...this.tasks.values()]
                .filter((task) => task.owner.sessionId === sessionId && (!isShellTask(task) || task.published))
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
        try {
            if (task.status === "running") {
                task.suppressTerminalNotification = true;
                if (isAgentTask(task)) task.interruptRequested = false;
                task.controller.abort("user-cancel");
                await task.completion;
            }
        } finally {
            if (isAgentTask(task)) await task.thread.close();
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
        return this.getRunningSummary(sessionId).total > 0 || [...this.tasks.values()].some(task => isReviewTask(task) && task.status === "running" && (sessionId === undefined || task.owner.sessionId === sessionId));
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
            if (isReviewTask(task)) continue;
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
            // Starts own allocation/publication too; a Task may still hold its placeholder completion.
            await Promise.allSettled([...this.starts]);
            await Promise.allSettled([...this.tasks.values()].map(task => task.completion));
            await Promise.allSettled([...this.tasks.values()].filter(isAgentTask).map(task => task.thread.close()));
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
                (isAgentTask(task) || isReviewTask(task)) &&
                task.owner.sessionId === sessionId &&
                task.status === "running"
        ).length;
    }

    private reserveTaskSlot(agent = false): () => void {
        const retainedAgent = (task: ManagedTask) => isAgentTask(task) && !task.stopRequested && task.status !== "cancelled";
        const retained = [...this.tasks.values()].filter(retainedAgent).length;
        if (agent && retained >= MAX_TRACKED_TASKS) {
            throw new Error(`Retained Agent limit reached: ${MAX_TRACKED_TASKS}; use task stop to explicitly close an Agent before starting another. Existing threads remain available for follow-up.`);
        }
        while (this.tasks.size - retained + this.archived.size + this.pendingTaskStarts + (agent ? 0 : 1) > MAX_TRACKED_TASKS) {
            let evicted = false;
            for (const [id, task] of this.tasks) {
                if (retainedAgent(task) || task.status === "running" || task.notificationPending) continue;
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
            version: 8,
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
                    ...(restored.kind === "shell" ? {phase: "finished" as const} : {}),
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
                (restored.kind === "review") || (restored.kind === "shell" && isExpectedShellShutdown(restored))
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
    memory:MemoryRuntimeLike,
    reviewTask: TaskReviewRunner
): TaskRuntimeLike {
    return new TaskRuntime(
        shellRunner,
        createSubagentThread,
        createTaskJournal(storage, cwd),
        subagents,
        memory,
        reviewTask
    );
}
