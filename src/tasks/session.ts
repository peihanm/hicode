import {createTurnAbortController} from "../runtime/abort.js";
import type {AgentMessaging} from "../runtime/agentMessaging.js";
import type {TaskRuntime} from "./runtime.js";
import type {
    AgentFollowupResult,
    AgentTaskSnapshot,
    MemoryTaskSnapshot,
    RunShellTaskInput,
    RunShellTaskResult,
    RunningTaskSummary,
    ShellTaskSnapshot,
    StartAgentTaskInput,
    StartMemoryTaskInput,
    StartShellTaskInput,
    StartTaskReviewInput,
    TaskEventEnvelope,
    TaskNotification,
    TaskReviewSnapshot,
    TaskSessionBinding,
    TaskSessionLike,
    TaskSnapshot,
} from "./types.js";

/** A child can manage only Shell tasks it created. Root retains resource ownership. */
export type ChildTaskAccess = Pick<TaskSessionLike, "sessionId" | "shellContinuation" | "startShell" | "runShell" | "get" | "readShellOutput" | "list" | "stop" | "subscribe" | "acknowledgeNotification">;

export function isParentTaskSession(tasks: TaskSessionLike | ChildTaskAccess): tasks is TaskSessionLike {
    return "startAgent" in tasks;
}

/** The creator owns disposal; tools receive only the narrowed tasks capability. */
export interface ChildShellSession {tasks: ChildTaskAccess; close(): Promise<void>;}

export type ScopedTaskBinding = TaskSessionBinding & {signal: AbortSignal};

export class TaskSession implements TaskSessionLike {
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
