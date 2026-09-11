import { describe, expect, test } from "bun:test";
import { createFileChange } from "../../src/fileChanges/index.js";
import {
  UITurnEventStore,
} from "../../src/ui/turn/eventStore.js";
import { selectLiveThreads } from "../../src/ui/turn/useTurnController.js";

describe("UITurnEventStore", () => {
  test("恢复 history，并分别归约 token、文本和用户输入", () => {
    const store = new UITurnEventStore({
      history: [
        { role: "system", content: "system" },
        { role: "user", origin: "user" as const, content: "之前的问题" },
        { role: "assistant", content: "之前的回答" },
      ],
    });

    store.handleEvent({
      type: "token_update",
      tokenCount: 120,
      percentUsed: 0.12,
      warning: false,
      status: "actual",
    });
    expect(store.getSnapshot().threads).toHaveLength(2);
    expect(store.getSnapshot().staticThreads).toHaveLength(2);
    expect(store.getSnapshot().tokenInfo).toEqual({
      count: 120,
      percentUsed: 0.12,
      warning: false,
      status: "actual",
    });

    store.appendUser("新的问题");
    store.handleEvent({ type: "assistant_text", content: "新的回答" });
    expect(store.getSnapshot().threads.map((thread) => thread.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  test("新会话不伪装成零 token，并保留恢复会话的初始估算", () => {
    expect(new UITurnEventStore().getSnapshot().tokenInfo.status).toBe(
      "unavailable"
    );

    const initialTokenInfo = {
      count: 88,
      percentUsed: 0.01,
      warning: false,
      status: "estimated" as const,
    };
    const store = new UITurnEventStore({ initialTokenInfo });
    expect(store.getSnapshot().tokenInfo).toEqual(initialTokenInfo);

    store.handleEvent({
      type: "token_update",
      tokenCount: 234,
      percentUsed: 0.02,
      warning: false,
      status: "estimated",
    });
    expect(store.getSnapshot().tokenInfo).toEqual({
      count: 234,
      percentUsed: 0.02,
      warning: false,
      status: "estimated",
    });
  });

  test("Memory 更新事件不在 TUI 重复插入 assistant 消息", () => {
    const store = new UITurnEventStore();
    store.handleEvent({
      type: "memory_update",
      source: "automatic",
      changes: [
        {
          action: "created",
          key: "feedback-brief-replies",
          memoryType: "feedback",
        },
      ],
    });

    expect(store.getSnapshot().threads).toEqual([]);
  });

  test("模型流事件只更新临时生成进度，不污染消息列表", () => {
    const store = new UITurnEventStore();
    store.handleEvent({ type: "model_stream_start" });
    expect(store.getSnapshot().modelStream).toEqual({
      phase: "requesting",
      outputCharacters: 0,
      estimatedOutputTokens: 0,
    });

    store.handleEvent({
      type: "model_stream_progress",
      phase: "tool_input",
      outputCharacters: 480,
      estimatedOutputTokens: 120,
      toolName: "write_file",
    });
    expect(store.getSnapshot().modelStream).toEqual({
      phase: "tool_input",
      outputCharacters: 480,
      estimatedOutputTokens: 120,
      toolName: "write_file",
    });
    expect(store.getSnapshot().threads).toEqual([]);

    store.handleEvent({
      type: "model_stream_progress",
      phase: "stalled",
      outputCharacters: 480,
      estimatedOutputTokens: 120,
      idleMilliseconds: 60_000,
    });
    expect(store.getSnapshot().modelStream).toMatchObject({
      phase: "stalled",
      idleMilliseconds: 60_000,
    });

    store.handleEvent({ type: "model_stream_end" });
    expect(store.getSnapshot().modelStream).toBeNull();
  });

  test("按 iteration 固化同轮 diff，且固化前不进入 live 区", () => {
    const store = new UITurnEventStore();
    store.appendUser("修改文件");
    store.handleEvent({ type: "iteration", current: 1, max: 5 });
    expect(store.getSnapshot().staticThreads).toHaveLength(1);

    const first = createFileChange({
      path: "app.ts",
      kind: "create",
      oldContent: "",
      newContent: "first\n",
    });
    store.handleEvent({
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "write-1",
      name: "write_file",
      args: "{}",
    });
    store.handleEvent({
      type: "tool_call_end",
      turnId: "turn-1",
      toolCallId: "write-1",
      result: "ok",
      outcome: "ok",
      uiData: { type: "file_change", change: first },
    });
    expect(
      store.getSnapshot().threads.filter((thread) =>
        thread.role === "file_change_group"
      )
    ).toHaveLength(1);
    expect(
      selectLiveThreads(
        store.getSnapshot().threads,
        store.getSnapshot().staticThreads
      ).filter((thread) => thread.role === "file_change_group")
    ).toHaveLength(0);

    store.handleEvent({ type: "iteration", current: 2, max: 5 });
    expect(
      store
        .getSnapshot()
        .staticThreads.filter((thread) => thread.role === "file_change_group")
    ).toHaveLength(1);
    expect(
      selectLiveThreads(
        store.getSnapshot().threads,
        store.getSnapshot().staticThreads
      ).filter((thread) => thread.role === "file_change_group")
    ).toHaveLength(0);
    const second = createFileChange({
      path: "app.ts",
      kind: "update",
      oldContent: "first\n",
      newContent: "second\n",
    });
    store.handleEvent({
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "write-2",
      name: "edit_file",
      args: "{}",
    });
    store.handleEvent({
      type: "tool_call_end",
      turnId: "turn-1",
      toolCallId: "write-2",
      result: "ok",
      outcome: "ok",
      uiData: { type: "file_change", change: second },
    });
    expect(
      store.getSnapshot().threads.filter((thread) =>
        thread.role === "file_change_group"
      )
    ).toHaveLength(2);
    expect(
      selectLiveThreads(
        store.getSnapshot().threads,
        store.getSnapshot().staticThreads
      ).filter((thread) => thread.role === "file_change_group")
    ).toHaveLength(0);

    store.settleTurn();
    expect(store.getSnapshot().staticThreads).toHaveLength(
      store.getSnapshot().threads.length
    );
  });

  test("连续探索保留在 live 聚合区，遇到语义边界后原子固化", () => {
    const store = new UITurnEventStore();
    store.handleEvent({ type: "iteration", current: 1, max: 5 });
    store.handleEvent({
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "read-1",
      name: "read_file",
      args: JSON.stringify({ path: "README.md" }),
    });
    expect(store.getSnapshot().staticThreads).toHaveLength(0);
    expect(store.getSnapshot().threads[0]).toMatchObject({
      role: "tool_call",
      status: "running",
    });

    store.handleEvent({
      type: "tool_call_end",
      turnId: "turn-1",
      toolCallId: "read-1",
      result: "文件: README.md\n行范围: 1-60 / 60\n\n内容",
      outcome: "ok",
    });
    const completed = store.getSnapshot();
    expect(completed.staticThreads).toHaveLength(0);
    expect(selectLiveThreads(completed.threads, completed.staticThreads)[0]).toMatchObject({
      role: "tool_call",
      status: "done",
    });

    store.handleEvent({ type: "iteration", current: 2, max: 5 });
    expect(store.getSnapshot().staticThreads).toHaveLength(0);
    store.handleEvent({
      type: "assistant_text",
      content: "读取完成",
    });
    expect(store.getSnapshot().staticThreads).toHaveLength(2);
    expect(selectLiveThreads(
      store.getSnapshot().threads,
      store.getSnapshot().staticThreads
    )).toEqual([]);
  });

  test("最终 Assistant 文本原子进入 Static，不经过 live 区重复渲染", () => {
    const store = new UITurnEventStore();
    store.handleEvent({
      type: "assistant_text",
      content: "完成说明\n".repeat(100),
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.staticThreads).toHaveLength(1);
    expect(snapshot.staticThreads[0]).toMatchObject({
      role: "assistant",
      text: "完成说明\n".repeat(100),
    });
    expect(selectLiveThreads(snapshot.threads, snapshot.staticThreads))
      .toEqual([]);
  });

  test("过程说明先进入 Static，随后工具调用继续显示", () => {
    const store = new UITurnEventStore();
    store.handleEvent({
      type: "assistant_text",
      content: "已定位根因，接下来修改事件链。",
      phase: "commentary",
    });
    store.handleEvent({
      type: "tool_call_start",
      turnId: "turn-commentary",
      toolCallId: "edit-after-commentary",
      name: "edit_file",
      args: JSON.stringify({path: "src/agent/runner.ts"}),
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.staticThreads).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "已定位根因，接下来修改事件链。",
      }),
    ]);
    expect(selectLiveThreads(snapshot.threads, snapshot.staticThreads)).toEqual([
      expect.objectContaining({
        role: "tool_call",
        toolCallId: "edit-after-commentary",
      }),
    ]);
  });

  test("长用户 Prompt 在 Plan 工具出现前已经原子进入 Static", () => {
    const store = new UITurnEventStore();
    const prompt = "请实现一个完整的五子棋游戏。\n".repeat(100);
    store.appendUser(prompt);

    const submitted = store.getSnapshot();
    expect(submitted.threads).toHaveLength(1);
    expect(submitted.staticThreads).toHaveLength(1);
    expect(submitted.staticThreads[0]).toMatchObject({
      role: "user",
      text: prompt,
    });
    expect(selectLiveThreads(submitted.threads, submitted.staticThreads))
      .toEqual([]);

    store.handleEvent({
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "plan-1",
      name: "ask_user",
      args: "{}",
    });

    const planning = store.getSnapshot();
    expect(planning.threads.filter((thread) => thread.role === "user"))
      .toHaveLength(1);
    expect(planning.staticThreads.filter((thread) => thread.role === "user"))
      .toHaveLength(1);
    expect(selectLiveThreads(planning.threads, planning.staticThreads))
      .toEqual([expect.objectContaining({
        role: "tool_call",
        name: "ask_user",
      })]);
  });

  test("快速 Slash 回答与用户命令按原时间顺序一起进入 Static", () => {
    const store = new UITurnEventStore();
    store.appendUser("/agents");
    store.handleEvent({
      type: "assistant_text",
      content: "Agents · 2 个可用",
    });

    const snapshot = store.getSnapshot();
    expect(snapshot.staticThreads.map((thread) => thread.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(snapshot.staticThreads.map((thread) =>
      thread.role === "user" || thread.role === "assistant"
        ? thread.text
        : undefined
    )).toEqual(["/agents", "Agents · 2 个可用"]);
    expect(selectLiveThreads(snapshot.threads, snapshot.staticThreads))
      .toEqual([]);
  });

  test("同阶段 stream delta 只写 progress ref，不通知根 UI", () => {
    const store = new UITurnEventStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.handleEvent({ type: "model_stream_start" });
    store.handleEvent({
      type: "model_stream_progress",
      phase: "tool_input",
      outputCharacters: 4,
      estimatedOutputTokens: 1,
      toolName: "write_file",
    });
    const afterPhaseChange = notifications;

    for (let token = 2; token <= 2_000; token += 1) {
      store.handleEvent({
        type: "model_stream_progress",
        phase: "tool_input",
        outputCharacters: token * 4,
        estimatedOutputTokens: token,
        toolName: "write_file",
      });
    }
    expect(notifications).toBe(afterPhaseChange);
    expect(store.getSnapshot().modelStream?.estimatedOutputTokens).toBe(1);
    expect(
      store.getModelStreamProgressRef().current?.estimatedOutputTokens
    ).toBe(2_000);

    store.handleEvent({
      type: "model_stream_progress",
      phase: "content",
      outputCharacters: 8_004,
      estimatedOutputTokens: 2_001,
    });
    expect(notifications).toBe(afterPhaseChange + 1);
    expect(store.getSnapshot().modelStream?.phase).toBe("content");
  });

  test("连续重试更新根 UI 的原因和次数，恢复输出后清除重试信息", () => {
    const store = new UITurnEventStore();
    let notifications = 0;
    store.subscribe(() => notifications++);
    for (const attempt of [2, 3]) {
      store.handleEvent({type: "model_stream_progress", phase: "retrying",
        outputCharacters: 0, estimatedOutputTokens: 0,
        retry: {reason: "http", attempt, maxAttempts: 3}});
      expect(store.getSnapshot().modelStream?.retry?.attempt).toBe(attempt);
    }
    expect(notifications).toBe(2);
    store.handleEvent({type: "model_stream_progress", phase: "content",
      outputCharacters: 4, estimatedOutputTokens: 1});
    expect(store.getSnapshot().modelStream?.retry).toBeUndefined();
  });

  test("只持久化成功的 file change", () => {
    const store = new UITurnEventStore();
    const change = createFileChange({
      path: "src/a.ts",
      kind: "create",
      oldContent: "",
      newContent: "hello\n",
    });

    store.handleEvent({
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "write_file",
      args: "{}",
    });
    store.handleEvent({
      type: "tool_call_end",
      toolCallId: "call-1",
      result: "failed",
      outcome: "failed",
      turnId: "turn-1",
      uiData: { type: "file_change", change },
    });
    expect(
      store.getPersistedUIEvents().filter((event) => event.type === "file_change")
    ).toEqual([]);

    store.handleEvent({type: "tool_call_start", turnId: "turn-1", toolCallId: "call-2", name: "write_file", args: "{}"});
    store.handleEvent({
      type: "tool_call_end",
      toolCallId: "call-2",
      result: "ok",
      outcome: "ok",
      turnId: "turn-1",
      uiData: { type: "file_change", change },
    });
    expect(
      store.getPersistedUIEvents().filter((event) => event.type === "file_change")
    ).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        toolCallId: "call-2",
        timestamp: expect.any(String),
      }),
    ]);
  });

  test("持久化同一 turn 的连续文件修改时保存净 diff", () => {
    const store = new UITurnEventStore();
    const changes = [
      createFileChange({
        path: "app.py",
        kind: "create",
        oldContent: "",
        newContent: "broken\n",
      }),
      createFileChange({
        path: "app.py",
        kind: "update",
        oldContent: "broken\n",
        newContent: "fixed\nfinal\n",
      }),
    ];
    for (const [index, change] of changes.entries()) {
      const toolCallId = `call-${index}`;
      store.handleEvent({
        type: "tool_call_start",
        turnId: "turn-1",
        toolCallId,
        name: index === 0 ? "write_file" : "edit_file",
        args: "{}",
      });
      store.handleEvent({
        type: "tool_call_end",
        turnId: "turn-1",
        toolCallId,
        result: "ok",
        outcome: "ok",
        uiData: { type: "file_change", change },
      });
    }

    const restored = JSON.parse(
      JSON.stringify(store.getPersistedUIEvents())
    ) as ReturnType<UITurnEventStore["getPersistedUIEvents"]>;
    expect(restored).toHaveLength(3);
    expect(restored.filter((event) => event.type === "file_change")).toHaveLength(1);
    expect(restored.filter((event) => event.type === "tool_call")).toHaveLength(2);
    const restoredChange = restored.findLast(
      (event) => event.type === "file_change"
    );
    expect(restoredChange?.change).toMatchObject({
      kind: "create",
      scope: "turn",
      linesAdded: 2,
      linesRemoved: 0,
    });
    expect(JSON.stringify(restored)).not.toContain("oldContent");
    expect(JSON.stringify(restored)).not.toContain("newContent");
  });

  test("error thread 使用现有错误文案", () => {
    const store = new UITurnEventStore();
    store.appendError(new Error("boom"));
    expect(store.getSnapshot().threads[0]).toMatchObject({
      role: "assistant",
      text: "出错: boom",
    });
    expect(store.getSnapshot().staticThreads).toHaveLength(1);
  });

    test("warning 只追加可见 thread，不进入 persisted UI events", () => {
    const store = new UITurnEventStore();
    store.appendWarning("session save failed");
    expect(store.getSnapshot().threads[0]).toMatchObject({
      role: "assistant",
      text: "警告: session save failed",
    });
    expect(store.getPersistedUIEvents()).toEqual([]);
    expect(store.getSnapshot().staticThreads).toHaveLength(1);
    });

    test("Compact 状态是完整消息，直接进入 Static", () => {
      const store = new UITurnEventStore();
      store.handleEvent({
        type: "compact_start",
        tokenCount: 20_000,
        threshold: 120_000,
        trigger: "manual",
      });
      store.handleEvent({
        type: "compact_end",
        preTokenCount: 20_000,
        postTokenCount: 8_000,
        trigger: "manual",
      });

      expect(store.getSnapshot().staticThreads).toHaveLength(2);
      expect(selectLiveThreads(
        store.getSnapshot().threads,
        store.getSnapshot().staticThreads
      )).toEqual([]);
    });

    test("后台任务通知进入专用 thread，不伪装成 assistant 回复", () => {
        const store = new UITurnEventStore();
        store.appendTaskNotification({
            notificationId: "a".repeat(64),
            taskId: "task-1",
            sessionId: "session-1",
            ownerToolCallId: "bash-1",
            kind: "shell",
            label: "node server.js",
            status: "failed",
            summary: "exit 1 · EADDRINUSE",
            resultId: "task_task-1",
            message: "后台任务失败",
        });

        expect(store.getSnapshot().threads.at(-1)).toMatchObject({
            role: "task_notification",
            taskId: "task-1",
            ownerToolCallId: "bash-1",
            summary: "exit 1 · EADDRINUSE",
        });
    });
});

test("TUI and shared Session collector persist the same paired events", async () => {
    const {SessionUIEventCollector} = await import("../../src/session/uiEventCollector.js");
    const shared = new SessionUIEventCollector();
    const tui = new UITurnEventStore();
    const events: import("../../src/agent/types.js").AgentEvent[] = [
        {type: "tool_call_end", turnId: "t", toolCallId: "orphan", result: "ignored", outcome: "ok"},
        {type: "tool_call_start", turnId: "t", toolCallId: "call", name: "write_file", args: "{}"},
        {type: "tool_call_end", turnId: "t", toolCallId: "call", result: "done", outcome: "ok",
            uiData: {type: "file_change", change: createFileChange({path: "a.ts", kind: "create", oldContent: "", newContent: "hello"})}},
        {type: "tool_call_end", turnId: "t", toolCallId: "call", result: "duplicate", outcome: "failed"},
    ];
    for (const event of events) {shared.handleEvent(event); tui.handleEvent(event);}
    const normalize = (events: readonly import("../../src/session/uiEvents.js").PersistedUIEvent[]) => events.map(({timestamp: _timestamp, ...event}) => event);
    expect(normalize(tui.getPersistedUIEvents())).toEqual(normalize(shared.getEvents()));
    expect(tui.getPersistedUIEvents().filter(event => event.type === "tool_call")).toHaveLength(1);
});
