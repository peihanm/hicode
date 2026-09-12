import {expect, test} from "bun:test";
import {TaskNotificationCenter} from "../../src/tasks/notifications.js";
import type {TaskSnapshot} from "../../src/tasks/types.js";
import {RuntimeMessageQueue} from "../../src/runtime/messageQueue.js";

const task: TaskSnapshot = {id: "task", kind: "shell", executionMode: "sandbox", owner: {sessionId: "session", toolCallId: "call"},
    command: "echo done", cwd: "/workspace", status: "completed", startedAt: "2026-09-05T00:00:00.000Z", output: "done"};

test("读取待交付通知不能提前持久化 ACK", async () => {
    const center = new TaskNotificationCenter();
    center.rememberArchived(task.id, false);
    const read = () => center.pending("session", [], [task], async () => task);
    expect(await read()).toHaveLength(1);
    expect(await read()).toHaveLength(1);
});

test("队列按每次运行的通知身份去重，消费后重投也不会重复", () => {
    const queue = new RuntimeMessageQueue();
    const notification = {notificationId: "a".repeat(64), taskId: "task", sessionId: "session", ownerToolCallId: "call",
        kind: "agent" as const, label: "worker", status: "completed" as const, summary: "done", message: "first"};
    queue.enqueueTask(notification);
    queue.enqueueTask({...notification, notificationId: "b".repeat(64), message: "second"});
    expect(queue.list()).toHaveLength(2);
    queue.createAgentInputChannel(() => {}).drainInitial();
    queue.enqueueTask(notification);
    expect(queue.list()).toHaveLength(0);
});

import {createTaskNotificationDelivery} from "../../src/runtime/taskNotificationDelivery.js";
import type {TaskNotification} from "../../src/tasks/types.js";

function deliveryFixture(queue = new RuntimeMessageQueue()) {
    const pending: TaskNotification[] = ["a", "b"].map(id => ({
        notificationId: id.repeat(64), taskId: id, sessionId: "session", ownerToolCallId: "call",
        kind: "shell", executionMode: "sandbox", label: id, status: "completed", summary: "done", message: id,
    }));
    const calls: string[] = [];
    let persistFailure = false;
    let ackFailure = false;
    let saved: {messages: ReturnType<RuntimeMessageQueue["list"]>; taskReceipts: string[]} | undefined;
    const tasks = {
        async pendingNotifications() { return [...pending]; },
        async acknowledgeNotification(notification: Pick<TaskNotification, "notificationId" | "taskId">) {
            calls.push(`ack:${notification.taskId}`);
            if (ackFailure) throw new Error("ACK disk failure");
            const index = pending.findIndex(item => item.notificationId === notification.notificationId);
            if (index >= 0) pending.splice(index, 1);
        },
    };
    const delivery = createTaskNotificationDelivery({
        tasks, queue,
        onQueued(notification) { calls.push(`queued:${notification.taskId}`); },
        async persist() {
            calls.push("persist");
            if (persistFailure) throw new Error("snapshot failure");
            saved = {messages: queue.list(), taskReceipts: queue.getTaskReceipts()};
        },
    });
    return {queue, pending, calls, tasks, delivery, saved: () => saved,
        failPersist(value: boolean) { persistFailure = value; },
        failAck(value: boolean) { ackFailure = value; }};
}

test("Session 保存失败不 ACK，重试不会重复排队", async () => {
    const fixture = deliveryFixture();
    fixture.failPersist(true);
    await expect(fixture.delivery.drain()).rejects.toThrow("snapshot failure");
    expect(fixture.pending).toHaveLength(2);
    expect(fixture.calls).toEqual(["queued:a", "persist"]);
    fixture.failPersist(false);
    await fixture.delivery.drain();
    expect(fixture.queue.list()).toHaveLength(2);
    expect(fixture.pending).toHaveLength(0);
    expect(fixture.calls).toEqual(["queued:a", "persist", "persist", "ack:a", "queued:b", "persist", "ack:b"]);
});

test("ACK 失败后恢复持久接收记录，已经消费的通知不重新注入", async () => {
    const fixture = deliveryFixture();
    fixture.failAck(true);
    await expect(fixture.delivery.drain()).rejects.toThrow("ACK disk failure");
    fixture.queue.createAgentInputChannel(() => {}).drainInitial();
    await expect(fixture.delivery.drain()).rejects.toThrow("ACK disk failure");
    const restored = new RuntimeMessageQueue(fixture.saved()!);
    fixture.failAck(false);
    const queued: string[] = [];
    const delivery = createTaskNotificationDelivery({tasks: fixture.tasks, queue: restored,
        async persist() {}, onQueued(notification) { queued.push(notification.taskId); }});
    await delivery.drain();
    expect(queued).toEqual(["b"]);
    expect(restored.list().map(message => message.content)).toEqual(["b"]);
    expect(fixture.pending).toHaveLength(0);
});

test("批量第二条遇到满队列不吞第一条，释放空间后可继续交付", async () => {
    const fixture = deliveryFixture();
    for (let index = 0; index < 31; index++) fixture.queue.enqueueUser(`user-${index}`);
    await expect(fixture.delivery.drain()).rejects.toThrow("limit reached: 32");
    expect(fixture.pending.map(item => item.taskId)).toEqual(["b"]);
    expect(fixture.saved()?.messages).toHaveLength(32);
    fixture.queue.dequeueNextUserInput();
    await fixture.delivery.drain();
    expect(fixture.pending).toHaveLength(0);
    expect(fixture.queue.list().filter(item => item.type === "task_notification")).toHaveLength(2);
});

test("交付过程中收到的新触发不会被合并 Promise 吞掉", async () => {
    const fixture = deliveryFixture();
    const first = fixture.pending[0]!;
    fixture.pending.splice(0);
    let reads = 0;
    let delivery: ReturnType<typeof createTaskNotificationDelivery>;
    delivery = createTaskNotificationDelivery({
        tasks: { ...fixture.tasks, async pendingNotifications() {
            reads++;
            if (reads === 1) {
                fixture.pending.push(first);
                queueMicrotask(() => { void delivery.drain(); });
                return [];
            }
            return fixture.tasks.pendingNotifications();
        }}, queue: fixture.queue, async persist() {}, onQueued() {},
    });
    await delivery.drain();
    expect(fixture.queue.list()).toHaveLength(1);
    expect(fixture.pending).toHaveLength(0);
});
