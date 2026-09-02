import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  createProcessTreeKiller,
  runShellCommand,
} from "../../src/tools/bash/process.js";

type SpawnProcess = typeof import("node:child_process").spawn;

function fakeChild(): ChildProcess & { killCalls: number } {
  const child = new EventEmitter() as ChildProcess & { killCalls: number };
  Object.defineProperty(child, "pid", { value: 12345 });
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

describe("Bash process tree termination", () => {
  test("跨 chunk 的 UTF-8 输出不会产生替换字符", async () => {
    const result = await runShellCommand({
      command: [
        "node -e \"",
        "process.stdout.write(Buffer.from([0xe4,0xbd]));",
        "setTimeout(() => process.stdout.write(Buffer.from([0xa0])), 20)",
        "\"",
      ].join(""),
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });

    expect(result.termination).toMatchObject({kind: "exit", code: 0});
    expect(result.stdout).toBe("你");
  });

  test("Windows taskkill 非零退出时回退 child.kill", async () => {
    const child = fakeChild();
    const spawnProcess = (() => {
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit("close", 1));
      return killer;
    }) as unknown as SpawnProcess;

    await createProcessTreeKiller({
      platform: "win32",
      spawnProcess,
    })(child);
    expect(child.killCalls).toBe(1);
  });

  test("Windows taskkill error 不会形成未处理事件", async () => {
    const child = fakeChild();
    const spawnProcess = (() => {
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit("error", new Error("missing taskkill")));
      return killer;
    }) as unknown as SpawnProcess;

    await createProcessTreeKiller({
      platform: "win32",
      spawnProcess,
    })(child);
    expect(child.killCalls).toBe(1);
  });

  test("Windows taskkill 挂起时超时回退", async () => {
    const child = fakeChild();
    const killer = new EventEmitter() as EventEmitter & {
      killCalls: number;
      kill: () => boolean;
    };
    killer.killCalls = 0;
    killer.kill = () => {
      killer.killCalls += 1;
      return true;
    };
    const spawnProcess = (() => killer) as unknown as SpawnProcess;

    await createProcessTreeKiller({
      platform: "win32",
      spawnProcess,
      taskkillTimeoutMs: 2,
    })(child);
    expect(killer.killCalls).toBe(1);
    expect(child.killCalls).toBe(1);
  });
});
