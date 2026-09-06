import { describe, expect, test } from "bun:test";
import {
  buildHeadlessRunSummary,
  formatHeadlessCliError,
  formatHeadlessOutput,
  formatHeadlessProgress,
} from "../../src/headless/output.js";
import type { AgentResult } from "../../src/agent/index.js";
import type { HeadlessToolCall } from "../../src/headless/types.js";

const completed: AgentResult = {
  reply: "完成",
  reason: "completed",
  iterations: 1,
};
const denied: HeadlessToolCall = {
  toolCallId: "denied",
  name: "write_file",
  args: "{}",
  outcome: "permission_denied",
};
const failed: HeadlessToolCall = {
  toolCallId: "failed",
  name: "bash",
  args: "{}",
  outcome: "failed",
};

describe("headless output", () => {
  const exitCode = ({
    result,
    toolCalls = [],
    subagents = [],
  }: {
    result: AgentResult;
    toolCalls?: HeadlessToolCall[];
    subagents?: Parameters<typeof buildHeadlessRunSummary>[0]["collector"]["subagents"];
  }) => buildHeadlessRunSummary({
    result,
    sessionId: "session-exit-code",
    permissionMode: "default",
        collaborationMode: "build",
    collector: {toolCalls, subagents, currentUIEvents: []},
    mcpServers: [],
  }).exitCode;

  test("exit code 遵守 interrupted > max turns > tool issue > success", () => {
    expect(
      exitCode({
        result: { ...completed, reason: "interrupted" },
        toolCalls: [denied, failed],
      })
    ).toBe(130);
    expect(
      exitCode({
        result: { ...completed, reason: "max_turns" },
        toolCalls: [denied],
      })
    ).toBe(3);
    expect(
      exitCode({
        result: { ...completed, reason: "permission_denied" },
      })
    ).toBe(2);
    expect(
      exitCode({
        result: completed,
        toolCalls: [denied],
      })
    ).toBe(2);
    expect(
      exitCode({
        result: completed,
      })
    ).toBe(0);
    expect(exitCode({result: completed, subagents: [{
      agentId: "reviewer-1", agentType: "project-reviewer",
      description: "检查数据竞争", status: "completed",
    }]})).toBe(0);
  });

  test("summary 分类 tool calls 并保持公开字段", () => {
    const summary = buildHeadlessRunSummary({
      result: completed,
      sessionId: "session-1",
      permissionMode: "default",
        collaborationMode: "build",
      collector: {
        toolCalls: [denied, failed],
        subagents: [],
        currentUIEvents: [],
      },
      mcpServers: [],
    });
    expect(Object.keys(summary)).toEqual([
      "ok",
      "exitCode",
      "sessionId",
      "reason",
      "iterations",
      "reply",
      "permissionMode",
      "collaborationMode",
      "toolCalls",
      "permissionDenials",
      "toolFailures",
      "subagents",
      "fileChanges",
      "mcpServers",
    ]);
    expect(summary).toMatchObject({ ok: false, exitCode: 2 });
  });

  test("text notes 保持顺序，JSON 使用两空格", () => {
    const summary = buildHeadlessRunSummary({
      result: { ...completed, reply: "  partial  " },
      sessionId: "session-1",
      permissionMode: "default",
        collaborationMode: "build",
      collector: {
        toolCalls: [denied, failed],
        subagents: [],
        currentUIEvents: [],
      },
      mcpServers: [],
    });
    const text = formatHeadlessOutput(summary, "text");
    expect(text.startsWith("partial\n\nHeadless note:")).toBe(true);
    expect(text.indexOf("denied")).toBeLessThan(text.indexOf("failed"));
    expect(formatHeadlessOutput(summary, "json")).toContain('\n  "exitCode": 2');
  });

  test("progress 只格式化受支持事件", () => {
    expect(
      formatHeadlessProgress({
        type: "assistant_text",
        content: "已完成调查，接下来修改实现。",
        phase: "commentary",
      })
    ).toBe("● 已完成调查，接下来修改实现。");
    expect(
      formatHeadlessProgress({
        type: "assistant_text",
        content: "任务完成",
        phase: "final",
      })
    ).toBeNull();
    expect(
      formatHeadlessProgress({
        type: "tool_call_start",
        turnId: "turn-1",
        toolCallId: "call-1",
        name: "read_file",
        args: JSON.stringify({ path: "src/a.ts" }),
      })
    ).toBe("● read_file src/a.ts");
    expect(
      formatHeadlessProgress({
        type: "compact_end",
        preTokenCount: 100,
        postTokenCount: 40,
        trigger: "auto",
      })
    ).toBe("  compact complete 100 -> 40");
    expect(
      formatHeadlessProgress({
        type: "memory_update",
        source: "explicit",
        changes: [
          {
            action: "updated",
            key: "project-release-context",
            memoryType: "project",
          },
        ],
      })
    ).toBe("● memory explicit: updated project-release-context");
    expect(
      formatHeadlessProgress({
        type: "token_update",
        tokenCount: 10,
        percentUsed: 0.1,
        warning: false,
        status: "actual",
      })
    ).toBeNull();
  });

  test("CLI error 保持 JSON envelope 与 ANSI text", () => {
    expect(JSON.parse(formatHeadlessCliError(new Error("boom"), "json"))).toEqual({
      ok: false,
      exitCode: 1,
      error: "boom",
    });
    expect(formatHeadlessCliError("boom", "text")).toBe(
      "\x1b[31mboom\x1b[0m"
    );
  });
});
