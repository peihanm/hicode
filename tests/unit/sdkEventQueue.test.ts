import {expect, test} from "bun:test";
import {AsyncEventQueue} from "../../src/sdk/eventQueue.js";
import type {ThreadEvent} from "../../src/sdk/protocol.js";

function event(sequence: number, text = "message"): ThreadEvent {
    return {protocolVersion: 1, sequence, threadId: "thread", emittedAt: "2026-09-05T00:00:00.000Z",
        type: "item.completed", turnId: "turn", item: {id: String(sequence), type: "agent_message", status: "completed", phase: "final", text}};
}

test("事件条数达到上限后阻塞生产，慢读恢复后顺序完整", async () => {
    const queue = new AsyncEventQueue(error => { throw error; });
    for (let i = 0; i < 256; i++) await queue.push(event(i));
    let admitted = false;
    const waiting = queue.push(event(256)).then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    const iterator = queue.iterate();
    expect((await iterator.next()).value?.sequence).toBe(0);
    await waiting;
    queue.close();
    const sequences: number[] = [];
    for await (const item of iterator) sequences.push(item.sequence);
    expect(sequences).toEqual(Array.from({length: 256}, (_, i) => i + 1));
});

test("字节预算独立于条数生效，满队列的进度不产生等待者", async () => {
    const queue = new AsyncEventQueue(error => { throw error; });
    await queue.push(event(0, "中".repeat(700_000)));
    let admitted = false;
    const waiting = queue.push(event(1, "中".repeat(700_000))).then(() => { admitted = true; });
    await Promise.resolve();
    expect(admitted).toBe(false);
    for (let i = 0; i < 1_000; i++) await queue.push({protocolVersion: 1, sequence: i + 2,
        threadId: "thread", emittedAt: "2026-09-05T00:00:00.000Z", type: "turn.progress", turnId: "turn",
        phase: "reasoning", outputCharacters: i, estimatedOutputTokens: i});
    const iterator = queue.iterate();
    await iterator.next();
    await waiting;
    queue.close();
    const remaining: ThreadEvent[] = [];
    for await (const value of iterator) remaining.push(value);
    expect(remaining.map(item => item.sequence)).toEqual([1]);
});

test("iterator return 会释放等待中的生产者", async () => {
    const queue = new AsyncEventQueue(error => { throw error; });
    const iterator = queue.iterate();
    const first = iterator.next();
    await queue.push(event(0));
    await first;
    for (let i = 1; i <= 256; i++) await queue.push(event(i));
    const waiting = queue.push(event(257));
    await iterator.return(undefined);
    await waiting;
    await queue.push(event(258));
});

test("超大事件明确断开并通知取消，不能伪装成正常终态", async () => {
    const failures: Error[] = [];
    const queue = new AsyncEventQueue(error => { failures.push(error); });
    await queue.push(event(0, "x".repeat(4 * 1024 * 1024)));
    expect(failures).toHaveLength(1);
    await expect(queue.iterate().next()).rejects.toThrow("单个事件超过");
});

test("不遵守背压的并发生产者同样有界并显式失败", async () => {
    const failures: Error[] = [];
    const queue = new AsyncEventQueue(error => { failures.push(error); });
    const writes = Array.from({length: 400}, (_, i) => queue.push(event(i)));
    await Promise.all(writes);
    expect(failures).toHaveLength(1);
    await expect(queue.iterate().next()).rejects.toThrow("并发等待上限");
});
