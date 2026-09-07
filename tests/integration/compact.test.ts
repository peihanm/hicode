import { describe, expect, test } from "bun:test";
import { compactHistoryForTest as compactHistory } from "../helpers/compact.js";
import { runAgentForTest as runAgent } from "../helpers/agent.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { Message, ToolCall } from "../../src/llm/types.js";
import { assistantText, createFakeLLM } from "../helpers/fakeLLM.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTurnAbortController, throwIfTurnAborted } from "../../src/runtime/abort.js";
import { getAutoCompactThreshold } from "../../src/context/window.js";

function overThresholdInput(model = "glm-test"): string {
  return "x".repeat(getAutoCompactThreshold(model) * 2 + 100);
}
function historyWithToolPair(): Message[] {
  const toolCall: ToolCall = {
    id: "pair-1",
    type: "function",
    function: { name: "read_file", arguments: '{"path":"a.ts"}' },
  };
  return [
    { role: "system", content: "system" },
    { role: "user", content: "较早任务".repeat(2_000) },
    { role: "assistant", content: "较早回答" },
    { role: "user", content: "最近任务" },
    { role: "assistant", content: null, tool_calls: [toolCall] },
    { role: "tool", content: "工具结果", tool_call_id: "pair-1" },
  ];
}

describe("compact integration", () => {
  test("真实 compact 写入摘要并保留完整 tool call/result 对", async () => {
    await withTempProject(async (cwd) => {
      const history = historyWithToolPair();
      const ctx = createTestContext(cwd);
      const fake = createFakeLLM([
        assistantText(
          "<analysis>内部草稿</analysis><summary>保留任务目标和验证状态</summary>"
        ),
      ]);

      const result = await compactHistory({
        history,
        ctx,
        tools: [],
        preTokenCount: 100_000,
        force: true,
        callLLM: fake.callLLM,
      });

      expect(result.compacted).toBe(true);
      expect(ctx.compactState.compactCount).toBe(1);
      expect(history[1]?.role).toBe("user");
      expect(history[1]?.content).toContain("保留任务目标和验证状态");
      expect(history[1]?.content).not.toContain("内部草稿");
      expect(
        history.some(
          (message) =>
            message.role === "assistant" && message.tool_calls?.[0]?.id === "pair-1"
        )
      ).toBe(true);
      expect(
        history.some(
          (message) => message.role === "tool" && message.tool_call_id === "pair-1"
        )
      ).toBe(true);
      expect(fake.calls[0]?.kind).toBe("compact");
      expect(fake.calls[0]?.tools).toEqual([]);
    });
  });

  test("Provider 超长拒绝保留原 History，不按比例丢弃重试", async () => {
    await withTempProject(async cwd => {
      const history = historyWithToolPair();
      const before = structuredClone(history);
      const fake = createFakeLLM([() => {throw new Error("prompt too long: context length limit");}]);
      const result = await compactHistory({history, ctx: createTestContext(cwd), tools: [],
        preTokenCount: 100_000, force: true, callLLM: fake.callLLM});
      expect(result.compacted).toBe(false);
      expect(fake.calls).toHaveLength(1);
      expect(history).toEqual(before);
    });
  });

  test("auto compact 失败会记录失败次数并保留原 history", async () => {
    await withTempProject(async (cwd) => {
      const history = historyWithToolPair();
      const before = structuredClone(history);
      const ctx = createTestContext(cwd);
      const fake = createFakeLLM([
        () => {
          throw new Error("network unavailable");
        },
      ]);

      const result = await compactHistory({
        history,
        ctx,
        tools: [],
        preTokenCount: 100_000,
        force: true,
        trigger: "auto",
        callLLM: fake.callLLM,
      });

      expect(result).toMatchObject({
        compacted: false,
        message: "network unavailable",
      });
      expect(ctx.compactState.consecutiveFailures).toBe(1);
      expect(history).toEqual(before);
    });
  });

  test("manual compact 失败不累计 auto failure fuse", async () => {
    await withTempProject(async (cwd) => {
      const history = historyWithToolPair();
      const before = structuredClone(history);
      const ctx = createTestContext(cwd);
      const fake = createFakeLLM([
        () => {
          throw new Error("manual network failure");
        },
      ]);

      const result = await compactHistory({
        history,
        ctx,
        tools: [],
        preTokenCount: 100_000,
        force: true,
        trigger: "manual",
        callLLM: fake.callLLM,
      });
      expect(result).toMatchObject({
        compacted: false,
        message: "manual network failure",
      });
      expect(ctx.compactState.consecutiveFailures).toBe(0);
      expect(history).toEqual(before);
    });
  });

  test("summary 返回后取消仍不 commit history 或 CompactState", async () => {
    await withTempProject(async (cwd) => {
      const history = historyWithToolPair();
      const before = structuredClone(history);
      const controller = createTurnAbortController();
      const ctx = createTestContext(cwd, { signal: controller.signal });
      const fake = createFakeLLM([
        () => {
          controller.abort("user-cancel");
          return assistantText("<summary>should not commit</summary>");
        },
      ]);

      await expect(
        compactHistory({
          history,
          ctx,
          tools: [],
          preTokenCount: 100_000,
          force: true,
          callLLM: fake.callLLM,
        })
      ).rejects.toMatchObject({
        name: "TurnInterruptedError",
        reason: "user-cancel",
      });
      expect(history).toEqual(before);
      expect(ctx.compactState).toEqual({
        consecutiveFailures: 0,
        compactCount: 0,
      });
    });
  });

  test("Agent 达到阈值时发出 compact start/end 事件", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];
      let compactCalls = 0;
      const fake = createFakeLLM([assistantText("压缩后完成")]);

      const result = await runAgent(
        overThresholdInput(),
        [{ role: "system", content: "system" }],
        (event) => events.push(event),
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          compactHistory: async ({ preTokenCount }) => {
            compactCalls += 1;
            return {
              compacted: true,
              preTokenCount,
              postTokenCount: 1,
              threshold: 1,
            };
          },
        }
      );

      expect(result.reason).toBe("completed");
      expect(compactCalls).toBe(1);
      expect(events.map((event) => event.type)).toContain("compact_start");
      expect(events.map((event) => event.type)).toContain("compact_end");
    });
  });

  test("Auto-Compact 普通失败后仍调用主模型", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];
      const fake = createFakeLLM([assistantText("继续完成")]);

      const result = await runAgent(
        overThresholdInput(),
        [{ role: "system", content: "system" }],
        (event) => events.push(event),
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          compactHistory: async ({ preTokenCount }) => ({
            compacted: false,
            preTokenCount,
            threshold: 1,
            message: "network unavailable",
          }),
        }
      );

      expect(result.reason).toBe("completed");
      expect(result.reply).toContain("继续完成");
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]?.kind).toBe("main");
      expect(events.map((event) => event.type)).toContain("compact_error");
    });
  });

  test("Auto-Compact 取消由 Agent 返回 interrupted 且不调用主模型", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const events: AgentEvent[] = [];
      const fake = createFakeLLM([]);

      const result = await runAgent(
        overThresholdInput(),
        [{ role: "system", content: "system" }],
        (event) => events.push(event),
        createTestContext(cwd, { signal: controller.signal }),
        {
          callLLM: fake.callLLM,
          compactHistory: async () => {
            controller.abort("user-cancel");
            throwIfTurnAborted(controller.signal);
            throw new Error("unreachable");
          },
        }
      );

      expect(result).toMatchObject({
        reason: "interrupted",
        abortReason: "user-cancel",
      });
      expect(fake.calls).toHaveLength(0);
      expect(events.filter((event) => event.type === "turn_interrupted"))
        .toHaveLength(1);
      expect(events.some((event) => event.type === "compact_error")).toBe(false);
    });
  });
});
