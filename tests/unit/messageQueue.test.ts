import {describe, expect, test} from "bun:test";
import {RuntimeMessageQueue} from "../../src/runtime/messageQueue.js";
import type {RuntimeQueuedMessage} from "../../src/runtime/messageQueue.js";

describe("RuntimeMessageQueue", () => {
    test("next 只由 Agent 安全边界消费，later 留给新 turn", () => {
        const queue = new RuntimeMessageQueue();
        queue.enqueueUser("继续检查", "next");
        queue.enqueueUser("最后总结", "later");

        expect(
            queue.createAgentInputChannel(() => {}).drainSafeBoundary()
                .map((message) => message.content)
        ).toEqual(["继续检查"]);
        expect(queue.dequeueDeferredTurnInput()?.content).toBe("最后总结");
    });

    test("取回可编辑输入但保留任务通知", () => {
        const queue = new RuntimeMessageQueue();
        queue.enqueueTask({
            taskId: "task-1",
            sessionId: "session-1",
            ownerToolCallId: "call-1",
            kind: "shell",
            label: "fixture",
            status: "completed",
            summary: "exit 0",
            message: "task done",
        });
        queue.enqueueUser("第一条", "next");
        queue.enqueueUser("第二条", "later");

        expect(queue.takeEditableInputs()).toEqual(["第一条", "第二条"]);
        expect(queue.list()).toHaveLength(1);
        expect(queue.list()[0]?.type).toBe("task_notification");
    });

    test("没有可编辑输入时返回空数组且不修改通知", () => {
        const queue = new RuntimeMessageQueue();
        queue.enqueueTask({
            taskId: "task-1",
            sessionId: "session-1",
            ownerToolCallId: "call-1",
            kind: "shell",
            label: "fixture",
            status: "failed",
            summary: "exit 1",
            message: "task failed",
        });

        expect(queue.takeEditableInputs()).toEqual([]);
        expect(queue.list()).toHaveLength(1);
        expect(queue.list()[0]?.type).toBe("task_notification");
    });

    test("同一 Task 的完成通知按 taskId 去重", () => {
        const queue = new RuntimeMessageQueue();
        const notification = {
            taskId: "task-1",
            sessionId: "session-1",
            ownerToolCallId: "call-1",
            kind: "shell" as const,
            label: "fixture",
            status: "completed" as const,
            summary: "exit 0",
            message: "task done",
        };
        queue.enqueueTask(notification);
        queue.enqueueTask({...notification, message: "duplicate"});

        expect(queue.list()).toHaveLength(1);
        expect(queue.list()[0]).toMatchObject({
            type: "task_notification",
            taskId: "task-1",
            content: "task done",
        });
        expect(
            queue.createAgentInputChannel(() => {}).drainInitial()[0]
        ).toMatchObject({
            source: "task_notification",
            taskId: "task-1",
            content: "<task-notification>\ntask done\n</task-notification>",
        });
    });

    test("恢复时同样拒绝超过实时队列限制的持久化消息", () => {
        const messages: RuntimeQueuedMessage[] = Array.from(
            {length: 33},
            (_, index) => ({
                id: `queued-${index}`,
                type: "user_input",
                priority: "later",
                content: `message-${index}`,
                createdAt: "2026-07-20T00:00:00.000Z",
            })
        );
        expect(() => new RuntimeMessageQueue({messages})).toThrow(
            "无效的运行中消息队列快照"
        );
    });

    test("subscriber 异常不会回滚已经完成的队列 mutation", () => {
        const queue = new RuntimeMessageQueue();
        queue.subscribe(() => {
            throw new Error("render failed");
        });
        expect(queue.enqueueUser("继续", "next").content).toBe("继续");
        expect(queue.list()).toHaveLength(1);
    });
});
