import {createToolRuntime} from "../../src/tools/runtime.js";
import {contentText, type MessageContent} from "../../src/images/content.js";
import { describe, expect, test } from "bun:test";
import {
  EMPTY_AGENT_INPUT_CHANNEL,
  type AgentRunner,
} from "../../src/agent/index.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { ToolContext } from "../../src/tools/types.js";
import { UITurnController } from "../../src/ui/turn/controller.js";
import { RuntimeMessageQueue } from "../../src/runtime/messageQueue.js";
import type {SlashCommandProcessor} from "../../src/slash/types.js";
import type {Todo} from "../../src/todos.js";

function createHarness(overrides: {
  importImages?: ConstructorParameters<typeof UITurnController>[0]["importImages"];
  validateImages?: ConstructorParameters<typeof UITurnController>[0]["validateImages"];
  restoreDraft?: ConstructorParameters<typeof UITurnController>[0]["restoreDraft"];
    runAgent?: AgentRunner;
  processSlashCommand?: SlashCommandProcessor["process"];
  getSlashBusyBehavior?: SlashCommandProcessor["getBusyBehavior"];
  persistSnapshot?: () => Promise<void>;
  runUserPromptHooks?: (
    input: string,
    ctx: ToolContext
  ) => Promise<{
    blocked: boolean;
    blockReason?: string;
    additionalUserContextBlocks: readonly string[];
  }>;
  now?: () => number;
  beginTurn?: (input: string) => Promise<void>;
  endTurn?: () => Promise<void>;
  initialize?: () => Promise<void>;
  getTodos?: () => readonly Todo[];
  runTurn?: ConstructorParameters<typeof UITurnController>[0]["runTurn"];
} = {}) {
  const events: AgentEvent[] = [];
  const users: MessageContent[] = [];
  const errors: unknown[] = [];
  const signals: AbortSignal[] = [];
  const messageQueue = new RuntimeMessageQueue();
  let agentCalls = 0;
  const runAgent =
    overrides.runAgent ??
    (async () => {
      agentCalls += 1;
      return { reply: "ok", reason: "completed", iterations: 1 };
    });
  const controller = new UITurnController({
    toolRuntime: createToolRuntime(),
    getHistory: () => [{ role: "system", content: "system" }],
    createContext: (signal) => {
      signals.push(signal);
      return { signal } as ToolContext;
    },
    onUserInput: (input) => users.push(input),
    onEvent: (event) => { events.push(event); },
    onUnexpectedError: (error) => errors.push(error),
    denyPendingPermission: () => {},
    initialize: overrides.initialize ?? (async () => {}),
    slashCommands: {
      process: overrides.processSlashCommand ?? (async () => false),
      getBusyBehavior:
        overrides.getSlashBusyBehavior ?? (() => "defer"),
    },
    runTurn: overrides.runTurn ?? (async (input, signal) => {
      signals.push(signal);
      try {
        await (overrides.beginTurn ?? (async () => {}))(contentText(input));
        const hookResult = await (
          overrides.runUserPromptHooks ??
          (async () => ({
            blocked: false,
            additionalUserContextBlocks: [],
          }))
        )(contentText(input), {signal} as ToolContext);
        if (signal.aborted) throw new Error("aborted");
        if (hookResult.blocked) {
          events.push({
            type: "assistant_text",
            content: `UserPromptSubmit Hook blocked the request: ${hookResult.blockReason ?? "No reason provided"}`,
          });
          return;
        }
        await runAgent(
          input,
          [{role: "system", content: "system"}],
          (event) => { events.push(event); },
          {signal} as ToolContext,
          EMPTY_AGENT_INPUT_CHANNEL,
          {
            getToolSchemas: () => [],
            executeTool: async () => "ok",
            isToolConcurrencySafe: () => false,
            getTodos: overrides.getTodos ?? (() => []),
            additionalUserContextBlocks:
              hookResult.additionalUserContextBlocks,
          }
        );
      } catch (error) {
        if (signal.aborted) {
          events.push({type: "turn_interrupted", reason: "user-cancel"});
        }
        throw error;
      } finally {
        try {
          await (overrides.endTurn ?? (async () => {}))();
        } finally {
          await (overrides.persistSnapshot ?? (async () => {}))();
        }
      }
    }),
    importImages: overrides.importImages ?? (async () => []),
    validateImages: overrides.validateImages ?? (() => {}),
    restoreDraft: overrides.restoreDraft ?? (() => {}),
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
  test("向 Agent 提供实时 Session Todo getter", async () => {
    let todos: Todo[] = [{
      content: "完成验证",
      status: "in_progress",
      activeForm: "正在完成验证",
    }];
    const harness = createHarness({
      getTodos: () => todos,
      runAgent: (async (
        _input,
        _history,
        _onEvent,
        _ctx,
        _inputChannel,
        options
      ) => {
        expect(options?.getTodos?.()).toEqual(todos);
        todos = [{...todos[0]!, status: "completed"}];
        expect(options?.getTodos?.()).toEqual(todos);
        return {reply: "completed", reason: "completed", iterations: 1};
      }) as AgentRunner,
    });

    await harness.controller.submit("完成任务");
    expect(harness.errors).toEqual([]);
  });

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
    let beginCalls = 0;
    const harness = createHarness({
      processSlashCommand: async () => {
        slashCalls += 1;
        return true;
      },
      beginTurn: async () => {
        beginCalls += 1;
      },
    });
    await harness.controller.submit("/help");
    expect(slashCalls).toBe(1);
    expect(harness.agentCalls).toBe(0);
    expect(beginCalls).toBe(0);
  });

  test("Controller 等待宿主完成 Hook、Agent 和保存流程", async () => {
    const calls: string[] = [];
    const harness = createHarness({
      beginTurn: async () => {
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
      endTurn: async () => {
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

  test("Session 输入保存失败时 fail closed，仍尝试收尾和保存", async () => {
    const calls: string[] = [];
    const harness = createHarness({
      beginTurn: async () => {
        calls.push("begin");
        throw new Error("session storage unavailable");
      },
      endTurn: async () => {
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
      content: "UserPromptSubmit Hook blocked the request: prompt policy",
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

  test("关闭时等待当前 Turn 的 Session 保存全部收尾", async () => {
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
      endTurn: async () => {
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

const imageReference = {
    type: "image" as const, imageId: `image-${"a".repeat(64)}`, label: "截图.png",
    image: {kind: "view" as const, version: 2 as const, source: {kind: "source" as const, version: 1 as const, sha256: "c".repeat(64), mimeType: "image/png" as const, byteLength: 100, width: 10, height: 5, orientation: 1}, region: {x: 0, y: 0, width: 10, height: 5}, sha256: "b".repeat(64), mimeType: "image/png" as const, byteLength: 100, width: 10, height: 5, sourceWidth: 10, sourceHeight: 5},
};

test("attachments import explicitly, survive queue editing and removal, and plain pasted paths stay text", async () => {
    const paths: string[][] = [], inputs: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const h = createHarness({importImages: async selected => {paths.push([...selected]); return [imageReference];},
        runTurn: async input => {inputs.push(input); await gate;}});
    const active = h.controller.submit("original");
    await h.controller.addImages(["some folder/截图.png"]);
    expect(paths).toEqual([["some folder/截图.png"]]);
    expect(h.controller.enqueue("fix screenshot")).toBe(true);
    expect(h.controller.getAttachmentSnapshot().images).toHaveLength(0);
    expect(h.controller.takeQueuedInputsForEditing("draft", 3)?.value).toBe("fix screenshot\ndraft");
    expect(h.controller.getAttachmentSnapshot().images).toEqual([imageReference]);
    h.controller.removeAttachment(0);
    expect(h.controller.getAttachmentSnapshot().images).toHaveLength(0);
    release(); await active;
    await h.controller.submit("some folder/截图.png");
    expect(inputs.at(-1)).toBe("some folder/截图.png");
    expect(paths).toHaveLength(1);
});

test("cancel attachment preparation does not cancel the running task or publish late images", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => {finish = resolve;});
    const h = createHarness({importImages: async (_paths, signal) => {
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}));
        return [imageReference];
    }, runTurn: async () => gate});
    const turn = h.controller.submit("run");
    const attachment = h.controller.addImages(["screen.png"]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.controller.cancel()).toBe(true);
    await attachment;
    expect(h.controller.getAttachmentSnapshot()).toEqual({images: [], preparing: false});
    expect(h.controller.getSnapshot().busy).toBe(true);
    finish(); await turn;
});

test("unsupported model preserves attachment draft and text, pure image input reaches runTurn", async () => {
    const drafts: string[] = [], inputs: MessageContent[] = [];
    let supported = false;
    const h = createHarness({importImages: async () => [imageReference], restoreDraft: text => drafts.push(text),
        validateImages: () => {if (!supported) throw new Error("unsupported");}, runTurn: async input => {inputs.push(input);}});
    await h.controller.addImages(["screen.png"]);
    expect(await h.controller.submit("inspect")).toBe(false);
    expect(drafts).toEqual(["inspect"]);
    expect(h.controller.getAttachmentSnapshot().images).toHaveLength(1);
    supported = true;
    expect(await h.controller.submit("")).toBe(true);
    expect(inputs).toEqual([[{type: "text", text: ""}, imageReference]]);
    expect(h.users).toEqual(inputs);
});


test("pasted image failures and cancellation restore text and preserve attachments", async () => {
    const drafts: string[] = [];
    const h = createHarness({restoreDraft: text => drafts.push(text), importImages: async (paths, signal) => {
        if (paths[0] === "good.png") return [imageReference];
        if (paths[0] === "cancel.png") {
            await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), {once: true}));
            return [imageReference];
        }
        throw new Error("permission denied");
    }});
    await h.controller.addImages(["good.png"]);
    expect(h.controller.pasteImage("denied.png", '"denied.png"')).toBe(true);
    await h.controller.waitForSettled();
    expect(drafts).toEqual(['"denied.png"']);
    expect(h.errors).toHaveLength(1);
    expect(h.controller.pasteImage("cancel.png", "cancel.png")).toBe(true);
    expect(h.controller.pasteImage("busy.png", "busy.png")).toBe(false);
    await Promise.resolve(); await Promise.resolve();
    h.controller.cancel();
    await h.controller.waitForSettled();
    expect(drafts).toEqual(['"denied.png"', "cancel.png"]);
    expect(h.controller.getAttachmentSnapshot()).toEqual({images: [imageReference], preparing: false});
    h.controller.dispose();
    expect(h.controller.pasteImage("after-close.png", "after-close.png")).toBe(false);
});

test("local slash commands clear old elapsed time without starting another work timer", async () => {
    let now = 1000;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const harness = createHarness({now: () => now, runTurn: async () => {now = 4000;},
        processSlashCommand: async () => {await gate; return true;}});
    await harness.controller.submit("real task");
    expect(harness.controller.getSnapshot().elapsedMs).toBe(3000);
    const pending = harness.controller.submit("/model");
    expect(harness.controller.getSnapshot()).toEqual({busy: true, stopping: false});
    now = 9000;
    release();
    await pending;
    expect(harness.controller.getSnapshot()).toEqual({busy: false, stopping: false});
});

test("unhandled slash input still times the Agent turn it starts", async () => {
    let now = 1000;
    const harness = createHarness({now: () => now,
        processSlashCommand: async () => {now = 2000; return false;},
        runTurn: async () => {now = 5000;}});
    await harness.controller.submit("/unhandled");
    expect(harness.controller.getSnapshot()).toEqual({busy: false, stopping: false, elapsedMs: 3000});
});
