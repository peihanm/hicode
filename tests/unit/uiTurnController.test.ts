import { describe, expect, test } from "bun:test";
import type { AgentRunner } from "../../src/agent/index.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { ToolContext } from "../../src/tools/types.js";
import { UITurnController } from "../../src/ui/turn/controller.js";
import { RuntimeMessageQueue } from "../../src/runtime/messageQueue.js";
import type {SlashCommandProcessor} from "../../src/slash/types.js";

function createHarness(overrides: {
    runAgent?: AgentRunner;
  processSlashCommand?: SlashCommandProcessor["process"];
  getSlashBusyBehavior?: SlashCommandProcessor["getBusyBehavior"];
  persistSnapshot?: () => Promise<void>;
  runUserPromptHooks?: ConstructorParameters<
    typeof UITurnController
  >[0]["runUserPromptHooks"];
  now?: () => number;
  beginCheckpoint?: (input: string) => Promise<void>;
  settleCheckpoint?: () => Promise<void>;
  getToolSchemas?: ConstructorParameters<typeof UITurnController>[0]["getToolSchemas"];
  executeTool?: ConstructorParameters<typeof UITurnController>[0]["executeTool"];
  isToolConcurrencySafe?: ConstructorParameters<
    typeof UITurnController
  >[0]["isToolConcurrencySafe"];
  initialize?: () => Promise<void>;
} = {}) {
  const events: AgentEvent[] = [];
  const users: string[] = [];
  const errors: unknown[] = [];
  const signals: AbortSignal[] = [];
  const messageQueue = new RuntimeMessageQueue();
  let agentCalls = 0;
  const controller = new UITurnController({
    getHistory: () => [{ role: "system", content: "system" }],
    createContext: (signal) => {
      signals.push(signal);
      return { signal } as ToolContext;
    },
    onUserInput: (input) => users.push(input),
    onEvent: (event) => events.push(event),
    onUnexpectedError: (error) => errors.push(error),
    onQueuedInputConsumed: () => {},
    onTurnSettled: () => {},
    denyPendingPermission: () => {},
    initialize: overrides.initialize ?? (async () => {}),
    slashCommands: {
      process: overrides.processSlashCommand ?? (async () => false),
      getBusyBehavior:
        overrides.getSlashBusyBehavior ?? (() => "defer"),
    },
    runUserPromptHooks:
      overrides.runUserPromptHooks ??
      (async () => ({
        blocked: false,
        additionalUserContextBlocks: [],
      })),
    beginCheckpoint: overrides.beginCheckpoint ?? (async () => {}),
    settleCheckpoint: overrides.settleCheckpoint ?? (async () => {}),
    runAgent:
      overrides.runAgent ??
      (async () => {
        agentCalls += 1;
        return { reply: "ok", reason: "completed", iterations: 1 };
      }),
    persistSnapshot: overrides.persistSnapshot ?? (async () => {}),
    getToolSchemas: overrides.getToolSchemas ?? (() => []),
    executeTool: overrides.executeTool ?? (async () => "ok"),
    isToolConcurrencySafe: overrides.isToolConcurrencySafe ?? (() => false),
    messageQueue,
    now: overrides.now ?? Date.now,
  });
  return {
    controller,
    events,
    users,
    errors,
    signals,
    messageQueue,
    get agentCalls() {
      return agentCalls;
    },
  };
}

describe("UITurnController", () => {
  test("Esc 只取消当前 turn，排队输入在清理后继续执行", async () => {
    let calls = 0;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const harness = createHarness({
      runAgent: (async (_input, _history, _onEvent, ctx) => {
        calls += 1;
        if (calls > 1) {
          return {reply: "replacement", reason: "completed", iterations: 1};
        }
        started();
        return new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve({
            reply: "cancelled",
            reason: "interrupted",
            iterations: 1,
            abortReason: "user-cancel",
          }), {once: true});
        });
      }) as AgentRunner,
    });

    const first = harness.controller.submit("first");
    await didStart;
    expect(harness.controller.enqueue("replacement")).toBe(true);
    expect(harness.controller.cancel()).toBe(true);
    await first;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.users).toEqual(["first", "replacement"]);
    expect(harness.errors).toEqual([]);
    expect(calls).toBe(2);
  });

  test("运行中的即时本地 Slash 不取消也不等待主 Turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slashInputs: string[] = [];
    const harness = createHarness({
      runAgent: (async () => {
        await gate;
        return {reply: "ok", reason: "completed", iterations: 1};
      }) as AgentRunner,
      getSlashBusyBehavior: (input) =>
        input === "/help" ? "immediate" : "defer",
      processSlashCommand: async (input) => {
        slashInputs.push(input);
        return true;
      },
    });

    const pending = harness.controller.submit("长任务");
    expect(harness.controller.enqueue("/help")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(slashInputs).toEqual(["/help"]);
    expect(harness.users).toEqual(["长任务", "/help"]);
    expect(harness.controller.getSnapshot().busy).toBe(true);
    expect(harness.messageQueue.list()).toEqual([]);
    expect(harness.signals).toHaveLength(2);
    expect(harness.signals[0]).not.toBe(harness.signals[1]);

    release();
    await pending;
  });

  test("向上取回所有排队输入并保留当前草稿的相对光标", () => {
    const harness = createHarness();
    harness.messageQueue.enqueueUser("第一条", "next");
    harness.messageQueue.enqueueUser("第二条", "later");

    expect(harness.controller.takeQueuedInputsForEditing("草稿内容", 2))
      .toEqual({
        value: "第一条\n第二条\n草稿内容",
        cursorOffset: 10,
      });
    expect(harness.messageQueue.list()).toEqual([]);
  });

  test("同步阻止重复 submit，完成后恢复 idle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      runAgent: (async () => {
        await gate;
        return { reply: "ok", reason: "completed", iterations: 1 };
      }) as AgentRunner,
    });

    const first = harness.controller.submit("first");
    const second = harness.controller.submit("second");
    expect(harness.controller.getSnapshot()).toEqual({
      busy: true,
      stopping: false,
      startedAt: expect.any(Number),
    });
    expect(await second).toBe(false);
    expect(harness.users).toEqual(["first"]);
    release();
    expect(await first).toBe(true);
    expect(harness.controller.getSnapshot()).toEqual({
      busy: false,
      stopping: false,
      elapsedMs: expect.any(Number),
    });
  });

  test("只在可见状态变化时通知 subscriber", async () => {
    const harness = createHarness();
    let notifications = 0;
    const unsubscribe = harness.controller.subscribe(() => {
      notifications += 1;
    });
    await harness.controller.submit("done");
    unsubscribe();
    expect(notifications).toBe(2);
  });

  test("Slash handled 跳过主 Agent", async () => {
    let slashCalls = 0;
    let checkpointCalls = 0;
    const harness = createHarness({
      processSlashCommand: async () => {
        slashCalls += 1;
        return true;
      },
      beginCheckpoint: async () => {
        checkpointCalls += 1;
      },
    });
    await harness.controller.submit("/help");
    expect(slashCalls).toBe(1);
    expect(harness.agentCalls).toBe(0);
    expect(checkpointCalls).toBe(0);
  });

  test("普通 Prompt 在 Hook 和 Agent 前建立 Checkpoint，结束后先收尾再保存", async () => {
    const calls: string[] = [];
    const harness = createHarness({
      beginCheckpoint: async () => {
        calls.push("begin");
      },
      runUserPromptHooks: async () => {
        calls.push("hook");
        return {blocked: false, additionalUserContextBlocks: []};
      },
      runAgent: (async () => {
        calls.push("agent");
        return {reply: "ok", reason: "completed", iterations: 1};
      }) as AgentRunner,
      settleCheckpoint: async () => {
        calls.push("settle");
      },
      persistSnapshot: async () => {
        calls.push("persist");
      },
    });

    await harness.controller.submit("修改文件");
    expect(calls).toEqual(["begin", "hook", "agent", "settle", "persist"]);
  });

  test("Session 初始化失败时保留用户问题但不运行 Agent", async () => {
    const harness = createHarness({
      initialize: async () => {
        throw new Error("journal unavailable");
      },
    });

    await harness.controller.submit("不能开始");

    expect(harness.users).toEqual(["不能开始"]);
    expect(harness.agentCalls).toBe(0);
    expect(harness.errors).toHaveLength(1);
  });

  test("Checkpoint 创建失败时 fail closed，仍尝试收尾和保存", async () => {
    const calls: string[] = [];
    const harness = createHarness({
      beginCheckpoint: async () => {
        calls.push("begin");
        throw new Error("checkpoint unavailable");
      },
      settleCheckpoint: async () => {
        calls.push("settle");
      },
      persistSnapshot: async () => {
        calls.push("persist");
      },
    });

    await harness.controller.submit("修改文件");

    expect(calls).toEqual(["begin", "settle", "persist"]);
    expect(harness.agentCalls).toBe(0);
    expect(harness.errors).toHaveLength(1);
  });

  test("Checkpoint 收尾失败不跳过 Session 保存", async () => {
    const calls: string[] = [];
    const harness = createHarness({
      settleCheckpoint: async () => {
        calls.push("settle");
        throw new Error("settle failed");
      },
      persistSnapshot: async () => {
        calls.push("persist");
      },
    });

    await harness.controller.submit("完成任务");

    expect(calls).toEqual(["settle", "persist"]);
    expect(harness.errors).toHaveLength(1);
  });

  test("UserPromptSubmit Hook 可以阻止请求且不调用主 Agent", async () => {
    const harness = createHarness({
      runUserPromptHooks: async () => ({
        blocked: true,
        blockReason: "prompt policy",
        additionalUserContextBlocks: [],
      }),
    });
    await harness.controller.submit("blocked");
    expect(harness.agentCalls).toBe(0);
    expect(harness.events).toContainEqual({
      type: "assistant_text",
      content: "UserPromptSubmit Hook 阻止了请求: prompt policy",
    });
  });

  test("Hook 临时上下文透传给 Agent options", async () => {
    let contextBlocks: readonly string[] | undefined;
    const harness = createHarness({
      runUserPromptHooks: async () => ({
        blocked: false,
        additionalUserContextBlocks: ["hook context"],
      }),
      runAgent: (async (
        _input,
        _history,
        _onEvent,
        _ctx,
        _inputChannel,
        options
      ) => {
        contextBlocks = options?.additionalUserContextBlocks;
        return {reply: "ok", reason: "completed", iterations: 1};
      }) as AgentRunner,
    });
    await harness.controller.submit("allowed");
    expect(contextBlocks).toEqual(["hook context"]);
  });

  test("普通异常进入 error callback", async () => {
    const harness = createHarness({
      runAgent: (async () => {
        throw new Error("boom");
      }) as AgentRunner,
    });
    await harness.controller.submit("fail");
    expect(harness.errors).toHaveLength(1);
    expect(harness.events).toEqual([]);
  });

  test("取消 abort signal，throw path 补发 interrupted，保存后才 idle", async () => {
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const harness = createHarness({
      runAgent: (async (_input, _history, _onEvent, ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("abort")), {
            once: true,
          });
        })) as AgentRunner,
      persistSnapshot: () => persistGate,
    });
    const pending = harness.controller.submit("long");
    expect(harness.controller.cancel()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.signals[0]?.reason).toBe("user-cancel");
    expect(harness.controller.getSnapshot()).toEqual({
      busy: true,
      stopping: true,
      startedAt: expect.any(Number),
    });
    expect(harness.events).toEqual([
      { type: "turn_interrupted", reason: "user-cancel" },
    ]);
    releasePersist();
    await pending;
    expect(harness.controller.getSnapshot().busy).toBe(false);
  });

  test("记录当前 turn 的开始时间并在完成后冻结总耗时", async () => {
    let now = 1_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      now: () => now,
      runAgent: (async () => {
        await gate;
        return { reply: "ok", reason: "completed", iterations: 1 };
      }) as AgentRunner,
    });

    const pending = harness.controller.submit("timed");
    expect(harness.controller.getSnapshot()).toEqual({
      busy: true,
      stopping: false,
      startedAt: 1_000,
    });
    now = 123_000;
    release();
    await pending;
    expect(harness.controller.getSnapshot()).toEqual({
      busy: false,
      stopping: false,
      elapsedMs: 122_000,
    });
  });

  test("Agent 正常返回 interrupted 时 controller 不重复事件", async () => {
    const harness = createHarness({
      runAgent: (async (_input, _history, onEvent) => {
        onEvent({ type: "turn_interrupted", reason: "user-cancel" });
        return {
          reply: "cancelled",
          reason: "interrupted",
          iterations: 1,
          abortReason: "user-cancel",
        };
      }) as AgentRunner,
    });
    await harness.controller.submit("normal interrupt");
    expect(harness.events).toEqual([
      { type: "turn_interrupted", reason: "user-cancel" },
    ]);
  });

  test("关闭时等待当前 Turn 的 checkpoint 与保存全部收尾", async () => {
    let releasePersist!: () => void;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const calls: string[] = [];
    const harness = createHarness({
      runAgent: (async (_input, _history, _onEvent, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve({
            reply: "cancelled",
            reason: "interrupted",
            iterations: 1,
            abortReason: "shutdown",
          }), {once: true});
        })) as AgentRunner,
      settleCheckpoint: async () => {
        calls.push("settle");
      },
      persistSnapshot: async () => {
        calls.push("persist-start");
        await persistGate;
        calls.push("persist-end");
      },
    });

    void harness.controller.submit("long");
    await Promise.resolve();
    harness.controller.dispose();
    let shutdownSettled = false;
    const shutdown = harness.controller.waitForSettled().then(() => {
      shutdownSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(["settle", "persist-start"]);
    expect(shutdownSettled).toBeFalse();
    releasePersist();
    await shutdown;
    expect(calls).toEqual(["settle", "persist-start", "persist-end"]);
  });
});
