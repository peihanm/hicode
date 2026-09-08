import {contentText} from "../../src/images/content.js";
import { describe, expect, test } from "bun:test";
import { createCompactState } from "../../src/context/index.js";
import type { SaveSessionSnapshotInput } from "../../src/session/index.js";
import { SessionSnapshotQueue } from "../../src/ui/turn/sessionQueue.js";

function snapshot(content: string): SaveSessionSnapshotInput {
  return {
    cwd: "/tmp/project",
    model: "glm-test",
    sessionId: "session-1",
    history: [{ role: "user", content }],
    todos: [],
    permissionMode: "default",
        collaborationMode: "build",
    compactState: createCompactState(),
    uiEvents: [],
  };
}

describe("SessionSnapshotQueue", () => {
  test("严格串行，失败被隔离且后续保存继续", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempt = 0;
    const queue = new SessionSnapshotQueue(async (input) => {
      attempt += 1;
      calls.push(contentText(input.history[0]?.content) ?? "");
      if (attempt === 1) {
        await gate;
        throw new Error("disk failed");
      }
    });

    const first = queue.enqueue(snapshot("first"));
    const second = queue.enqueue(snapshot("second"));
    await Promise.resolve();
    expect(calls).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(["first", "second"]);
  });

  test("enqueue 时捕获可变数组", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: Array<{content: string; discovered?: string}> = [];
    const queue = new SessionSnapshotQueue(async (input) => {
      await gate;
      observed.push({
        content: contentText(input.history[0]?.content) ?? "",
        discovered: input.toolDiscovery?.loadedNames[0],
      });
    });
    const input = snapshot("original");
    input.toolDiscovery = {
      version: 2,
      loadedNames: ["mcp__fixture__echo"],
    };
    const pending = queue.enqueue(input);
    input.history[0] = { role: "user", content: "mutated" };
    input.toolDiscovery.loadedNames[0] = "mcp__fixture__mutated";
    release();
    await pending;
    expect(observed).toEqual([{
      content: "original",
      discovered: "mcp__fixture__echo",
    }]);
  });

  test("连续相同失败只报告一次，成功后再次失败可重新报告", async () => {
    const errors: string[] = [];
    let attempt = 0;
    const queue = new SessionSnapshotQueue(
      async () => {
        attempt += 1;
        if (attempt !== 3) throw new Error("disk failed");
      },
      (error) => errors.push((error as Error).message)
    );

    await queue.enqueue(snapshot("first-failure"));
    await queue.enqueue(snapshot("same-failure"));
    await queue.enqueue(snapshot("recovered"));
    await queue.enqueue(snapshot("failure-again"));
    expect(errors).toEqual(["disk failed", "disk failed"]);
  });

  test("错误 callback 抛错不会破坏队列", async () => {
    let calls = 0;
    const queue = new SessionSnapshotQueue(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("save failed");
      },
      () => {
        throw new Error("render failed");
      }
    );

    await expect(queue.enqueue(snapshot("failure"))).resolves.toBeUndefined();
    await expect(queue.enqueue(snapshot("success"))).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  test("critical 保存向调用方返回失败且不阻塞后续队列", async () => {
    let calls = 0;
    const queue = new SessionSnapshotQueue(async () => {
      calls += 1;
      if (calls === 1) throw new Error("critical failed");
    });

    await expect(queue.enqueueCritical(snapshot("critical"))).rejects.toThrow(
      "critical failed"
    );
    await expect(queue.enqueue(snapshot("after"))).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  test("drain 等待已经入队的最终快照完成", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let completed = false;
    const queue = new SessionSnapshotQueue(async () => {
      await gate;
      completed = true;
    });

    void queue.enqueue(snapshot("final"));
    const drained = queue.drain();
    await Promise.resolve();
    expect(completed).toBeFalse();
    release();
    await drained;
    expect(completed).toBeTrue();
  });
});
