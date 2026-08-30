import {randomUUID} from "node:crypto";
import type {AgentInputChannel, QueuedAgentInput,} from "../agent/inputChannel.js";
import type {TaskNotification} from "../tasks/index.js";

export type MessagePriority = "next" | "later";

interface RuntimeQueuedMessageBase {
    id: string;
    priority: MessagePriority;
    content: string;
    createdAt: string;
}

export type RuntimeQueuedMessage = RuntimeQueuedMessageBase & (
    | {type: "user_input"}
    | {type: "task_notification"; taskId: string}
);

export interface RuntimeMessageQueueSnapshot {
    messages: readonly RuntimeQueuedMessage[];
}

const MAX_MESSAGES = 32;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_ID_CHARS = 256;
const EMPTY_SNAPSHOT: RuntimeMessageQueueSnapshot = {
    messages: [],
};

function byteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function isTimestamp(value: string): boolean {
    return value.length <= 64 && Number.isFinite(Date.parse(value));
}

/** Validate persisted queue state with the same limits used for live enqueue. */
export function normalizeRuntimeQueuedMessages(
    value: unknown
): RuntimeQueuedMessage[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_MESSAGES) return undefined;
    const messages: RuntimeQueuedMessage[] = [];
    const ids = new Set<string>();
    let totalBytes = 0;
    for (const item of value) {
        if (!item || typeof item !== "object") return undefined;
        const message = item as Record<string, unknown>;
        if (
            typeof message.id !== "string" ||
            message.id.length === 0 ||
            message.id.length > MAX_ID_CHARS ||
            ids.has(message.id) ||
            (message.type !== "user_input" &&
                message.type !== "task_notification") ||
            (message.priority !== "next" && message.priority !== "later") ||
            typeof message.content !== "string" ||
            message.content.trim().length === 0 ||
            typeof message.createdAt !== "string" ||
            !isTimestamp(message.createdAt)
        ) return undefined;
        const contentBytes = byteLength(message.content);
        totalBytes += contentBytes;
        if (contentBytes > MAX_MESSAGE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
            return undefined;
        }
        ids.add(message.id);
        if (message.type === "task_notification") {
            if (
                typeof message.taskId !== "string" ||
                message.taskId.length === 0 ||
                message.taskId.length > MAX_ID_CHARS
            ) return undefined;
            messages.push({
                id: message.id,
                type: message.type,
                priority: message.priority,
                content: message.content,
                createdAt: message.createdAt,
                taskId: message.taskId,
            });
        } else {
            if (message.taskId !== undefined) return undefined;
            messages.push({
                id: message.id,
                type: message.type,
                priority: message.priority,
                content: message.content,
                createdAt: message.createdAt,
            });
        }
    }
    return messages;
}

function asAgentInput(message: RuntimeQueuedMessage): QueuedAgentInput {
    return {
        id: message.id,
        source: message.type,
        content: message.type === "task_notification"
            ? `<task-notification>\n${message.content}\n</task-notification>`
            : message.content,
        ...(message.type === "task_notification"
            ? {taskId: message.taskId}
            : {}),
    };
}

export class RuntimeMessageQueue {
    private messages: RuntimeQueuedMessage[] = [];
    private readonly listeners = new Set<() => void>();
    private snapshot: RuntimeMessageQueueSnapshot = EMPTY_SNAPSHOT;

    constructor(input: {
        messages?: readonly RuntimeQueuedMessage[];
    } = {}) {
        const restored = input.messages === undefined
            ? []
            : normalizeRuntimeQueuedMessages(input.messages);
        if (!restored) throw new Error("无效的运行中消息队列快照");
        this.messages = restored;
        this.publish();
    }

    enqueueUser(content: string, priority: MessagePriority = "next"): RuntimeQueuedMessage {
        return this.enqueue({type: "user_input", content, priority});
    }

    enqueueTask(notification: TaskNotification): RuntimeQueuedMessage {
        const existing = this.messages.find(
            (message) =>
                message.type === "task_notification" &&
                message.taskId === notification.taskId
        );
        if (existing) return existing;
        return this.enqueue({
            type: "task_notification",
            content: notification.message,
            priority: "next",
            taskId: notification.taskId,
        });
    }

    createAgentInputChannel(
        onConsumed: (message: RuntimeQueuedMessage) => void
    ): AgentInputChannel {
        const consume = (predicate: (message: RuntimeQueuedMessage) => boolean) => {
            const messages = this.drain(predicate);
            for (const message of messages) onConsumed(message);
            return messages.map(asAgentInput);
        };
        return {
            drainInitial: () => consume(
                (message) => message.type === "task_notification"
            ),
            drainSafeBoundary: () => consume(
                (message) => message.priority === "next"
            ),
        };
    }

    dequeueDeferredTurnInput(): RuntimeQueuedMessage | undefined {
        const index = this.messages.findIndex(
            (message) =>
                message.type === "user_input" && message.priority === "later"
        );
        if (index < 0) return undefined;
        const [message] = this.messages.splice(index, 1);
        this.publish();
        return message;
    }

    demoteNextUserInputs(): void {
        let changed = false;
        this.messages = this.messages.map((message) => {
            if (message.type !== "user_input" || message.priority !== "next") {
                return message;
            }
            changed = true;
            return {...message, priority: "later"};
        });
        if (changed) this.publish();
    }

    takeEditableInputs(): readonly string[] {
        const restored = this.messages.filter(
            (message) => message.type === "user_input"
        );
        if (restored.length === 0) return [];
        const ids = new Set(restored.map((message) => message.id));
        this.messages = this.messages.filter((message) => !ids.has(message.id));
        this.publish();
        return restored.map((message) => message.content);
    }

    list(): readonly RuntimeQueuedMessage[] {
        return this.snapshot.messages;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): RuntimeMessageQueueSnapshot => this.snapshot;

    private enqueue(input: {
        type: "user_input";
        priority: MessagePriority;
        content: string;
    } | {
        type: "task_notification";
        priority: MessagePriority;
        content: string;
        taskId: string;
    }): RuntimeQueuedMessage {
        const content = input.content.trim();
        if (!content) throw new Error("不能排入空消息");
        if (byteLength(content) > MAX_MESSAGE_BYTES) {
            throw new Error(`单条运行中消息不能超过 ${MAX_MESSAGE_BYTES} 字节`);
        }
        if (this.messages.length >= MAX_MESSAGES) {
            throw new Error(`运行中消息队列已达到上限 ${MAX_MESSAGES}`);
        }
        const total = this.messages.reduce(
            (sum, message) => sum + byteLength(message.content),
            0
        );
        if (total + byteLength(content) > MAX_TOTAL_BYTES) {
            throw new Error(`运行中消息队列总量不能超过 ${MAX_TOTAL_BYTES} 字节`);
        }
        const base = {
            id: randomUUID(),
            priority: input.priority,
            content,
            createdAt: new Date().toISOString(),
        };
        const message: RuntimeQueuedMessage = input.type === "task_notification"
            ? {...base, type: input.type, taskId: input.taskId}
            : {...base, type: input.type};
        this.messages.push(message);
        this.publish();
        return message;
    }

    private drain(
        predicate: (message: RuntimeQueuedMessage) => boolean
    ): RuntimeQueuedMessage[] {
        const drained = this.messages.filter(predicate);
        if (drained.length === 0) return [];
        const ids = new Set(drained.map((message) => message.id));
        this.messages = this.messages.filter((message) => !ids.has(message.id));
        this.publish();
        return drained;
    }

    private publish(): void {
        this.snapshot = {
            messages: this.messages.map((message) => ({...message})),
        };
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // 状态订阅者不能反向破坏消息队列 mutation。
            }
        }
    }
}
