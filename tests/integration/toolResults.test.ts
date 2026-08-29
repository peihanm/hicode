import { describe, expect, test } from "bun:test";
import { runAgentForTest as runAgent } from "../helpers/agent.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { Message, ToolCall } from "../../src/llm/types.js";
import { assistantText, assistantToolCall, createFakeLLM } from "../helpers/fakeLLM.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("large tool result integration", () => {
  test("模型只收到引用并能通过 read_tool_result 恢复内容", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall(
          "bash",
          { command: "node -e \"process.stdout.write('z'.repeat(40000))\"" },
          "large-1"
        ),
        (options) => {
          const result = options.messages.find(
            (message) => message.role === "tool" && message.tool_call_id === "large-1"
          );
          expect(result?.content).toContain("<persisted-output>");
          expect((result?.content ?? "").length).toBeLessThan(5_000);
          return assistantToolCall(
            "read_tool_result",
            { result_id: "tr_large-1", offset: 0, limit: 100 },
            "read-1"
          );
        },
        (options) => {
          const result = options.messages.find(
            (message) => message.role === "tool" && message.tool_call_id === "read-1"
          );
          expect(result?.content).toContain("z".repeat(100));
          expect(result?.content).toContain("continue with offset=100");
          return assistantText("恢复成功");
        },
      ]);
      const history: Message[] = [{ role: "system", content: "system" }];
      const result = await runAgent(
        "生成大输出",
        history,
        () => {},
        createTestContext(cwd),
        { callLLM: fake.callLLM }
      );

      expect(result.reply).toBe("恢复成功");
      expect(
        history.find(
          (message) => message.role === "tool" && message.tool_call_id === "large-1"
        )?.content
      ).not.toContain("z".repeat(10_000));
    });
  });

  test("同批多个中等结果超过聚合预算时只替换必要结果", async () => {
    await withTempProject(async (cwd) => {
      const calls: ToolCall[] = [
        {
          id: "batch-a",
          type: "function",
          function: { name: "a", arguments: "{}" },
        },
        {
          id: "batch-b",
          type: "function",
          function: { name: "b", arguments: "{}" },
        },
      ];
      const fake = createFakeLLM([
        {
          message: { role: "assistant", content: null, tool_calls: calls },
          toolCalls: calls,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        (options) => {
          const results = options.messages.filter(
            (message): message is Extract<Message, { role: "tool" }> =>
              message.role === "tool"
          );
          expect(results).toHaveLength(2);
          expect(
            results.filter((message) =>
              message.content.includes("<persisted-output>")
            )
          ).toHaveLength(1);
          expect(results.reduce((sum, message) => sum + message.content.length, 0))
            .toBeLessThan(200_000);
          return assistantText("batch complete");
        },
      ]);
      const events: AgentEvent[] = [];
      const result = await runAgent(
        "批量输出",
        [{ role: "system", content: "system" }],
        (event) => events.push(event),
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async (name) => ({
            modelContent: name.repeat(120_000),
            displayContent: name.repeat(100),
            outcome: "ok",
          }),
        }
      );
      expect(result.reply).toBe("batch complete");
      expect(events.map((event) => event.type)).toContain("tool_result_persisted");
    });
  });
});
