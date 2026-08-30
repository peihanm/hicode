import { describe, expect, test } from "bun:test";
import { HeadlessEventCollector } from "../../src/headless/collector.js";
import { createFileChange } from "../../src/fileChanges/index.js";

describe("HeadlessEventCollector", () => {
  test("按 id 更新 tool outcome 并忽略 unknown end", () => {
    const collector = new HeadlessEventCollector();
    const outcomes = [
      ["ok", "ok"],
      ["denied", "permission_denied"],
      ["failed", "failed"],
      ["interrupted", "interrupted"],
    ] as const;
    for (const [eventOutcome] of outcomes) {
      collector.handleEvent({
        type: "tool_call_start",
        turnId: "turn-1",
        toolCallId: eventOutcome,
        name: "fixture",
        args: `{"outcome":"${eventOutcome}"}`,
      });
      collector.handleEvent({
        type: "tool_call_end",
        turnId: "turn-1",
        toolCallId: eventOutcome,
        result: eventOutcome,
        outcome: eventOutcome,
      });
    }
    collector.handleEvent({
      type: "tool_call_end",
      turnId: "turn-1",
      toolCallId: "unknown",
      result: "ignored",
      outcome: "ok",
    });
    expect(
      collector.getSnapshot().toolCalls.map((call) => call.outcome)
    ).toEqual(outcomes.map(([, expected]) => expected));
    expect(collector.getSnapshot().currentUIEvents.some((event) =>
      event.type === "tool_call" && event.toolCallId === "unknown"
    )).toBe(false);
  });

  test("undefined outcome 保持历史 ok 映射，persisted 可在 end 后更新", () => {
    const collector = new HeadlessEventCollector();
    collector.handleEvent({
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "bash",
      args: "{}",
    });
    collector.handleEvent({
      type: "tool_call_end",
      turnId: "turn-1",
      toolCallId: "call-1",
      result: "done",
    });
    collector.handleEvent({
      type: "tool_result_persisted",
      toolCallId: "call-1",
      persisted: {
        resultId: "tr_call-1",
        toolCallId: "call-1",
        toolName: "bash",
        path: "/tmp/result",
        byteLength: 10,
        originalByteLength: 10,
        preview: "done",
        complete: true,
        encoding: "utf-8",
      },
    });
    expect(collector.getSnapshot().toolCalls[0]).toMatchObject({
      outcome: "ok",
      result: "done",
      persisted: { resultId: "tr_call-1" },
    });
  });

  test("只有成功的 file change 进入本轮 UI events", () => {
    const collector = new HeadlessEventCollector();
    const change = createFileChange({
      path: "a.ts",
      kind: "create",
      oldContent: "",
      newContent: "a\n",
    });
    for (const id of ["failed", "ok"]) {
      collector.handleEvent({
        type: "tool_call_start",
        turnId: "turn-1",
        toolCallId: id,
        name: "write_file",
        args: "{}",
      });
    }
    collector.handleEvent({
      type: "tool_call_end",
      toolCallId: "failed",
      turnId: "turn-1",
      result: "failed",
      outcome: "failed",
      uiData: { type: "file_change", change },
    });
    collector.handleEvent({
      type: "tool_call_end",
      toolCallId: "ok",
      turnId: "turn-1",
      result: "ok",
      outcome: "ok",
      uiData: { type: "file_change", change },
    });
    expect(
      collector.getSnapshot().currentUIEvents.filter(
        (event) => event.type === "file_change"
      )
    ).toEqual([
      expect.objectContaining({
        type: "file_change",
        turnId: "turn-1",
        toolCallId: "ok",
        timestamp: expect.any(String),
      }),
    ]);
    expect(
      collector.getSnapshot().currentUIEvents.filter(
        (event) => event.type === "tool_call"
      ).map((event) => event.outcome)
    ).toEqual(["failed", "ok"]);
  });

  test("同一 turn 的文件修改事件保留最终净 diff", () => {
    const collector = new HeadlessEventCollector();
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
      const toolCallId = `change-${index}`;
      collector.handleEvent({
        type: "tool_call_start",
        turnId: "turn-1",
        toolCallId,
        name: "edit_file",
        args: "{}",
      });
      collector.handleEvent({
        type: "tool_call_end",
        turnId: "turn-1",
        toolCallId,
        result: "ok",
        outcome: "ok",
        uiData: { type: "file_change", change },
      });
    }

    const persistedChange = collector.getSnapshot().currentUIEvents.findLast(
      (event) => event.type === "file_change"
    );
    expect(persistedChange?.change).toMatchObject({
      kind: "create",
      scope: "turn",
      linesAdded: 2,
      linesRemoved: 0,
    });
  });

  test("映射 Subagent 生命周期但不保存 report", () => {
    const collector = new HeadlessEventCollector();
    collector.handleEvent({
      type: "subagent_start",
      agentId: "child-1",
      agentType: "Explore",
      description: "调查",
      parentToolCallId: "call-1",
    });
    collector.handleEvent({
      type: "subagent_end",
      agentId: "child-1",
      agentType: "Explore",
      reason: "max_turns",
      iterations: 3,
      toolUseCount: 4,
      durationMs: 50,
      report: "不进入 summary",
      transcriptPath: "/tmp/transcript",
    });
    expect(collector.getSnapshot().subagents).toEqual([
      {
        agentId: "child-1",
        agentType: "Explore",
        description: "调查",
        status: "failed",
        reason: "max_turns",
        iterations: 3,
        toolUseCount: 4,
        durationMs: 50,
        transcriptPath: "/tmp/transcript",
      },
    ]);
  });

  test("连续权限拒绝停止的 Subagent 标记为 failed", () => {
    const collector = new HeadlessEventCollector();
    collector.handleEvent({
      type: "subagent_start",
      agentId: "verification-1",
      agentType: "Verification",
      description: "验证",
      parentToolCallId: "call-1",
    });
    collector.handleEvent({
      type: "subagent_end",
      agentId: "verification-1",
      agentType: "Verification",
      reason: "permission_denied",
      iterations: 3,
      toolUseCount: 3,
      durationMs: 50,
      report: "权限拒绝",
      verificationVerdict: "PARTIAL",
    });
    expect(collector.getSnapshot().subagents[0]).toMatchObject({
      status: "failed",
      reason: "permission_denied",
      verificationVerdict: "PARTIAL",
    });
  });

  test("snapshot 数组和对象不能反向修改 collector", () => {
    const collector = new HeadlessEventCollector();
    collector.handleEvent({
      type: "tool_call_start",
      turnId: "turn-1",
      toolCallId: "call-1",
      name: "read_file",
      args: "{}",
    });
    const snapshot = collector.getSnapshot();
    snapshot.toolCalls[0]!.name = "mutated";
    snapshot.toolCalls.length = 0;
    expect(collector.getSnapshot().toolCalls).toEqual([
      expect.objectContaining({ name: "read_file" }),
    ]);
  });
});
