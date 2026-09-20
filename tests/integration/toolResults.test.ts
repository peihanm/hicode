import {fixtureToolSchemas} from "../helpers/fakeLLM.js";
import {contentText} from "../../src/images/content.js";
import { describe, expect, test } from "bun:test";
import { runAgentForTest as runAgent } from "../helpers/agent.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { Message, ToolCall } from "../../src/llm/types.js";
import { assistantText, assistantToolCall, createFakeLLM } from "../helpers/fakeLLM.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("large tool result integration", () => {
  test("失败命令执行一次后，模型可通过 Grep 定位预览省略的断言", async () => {
    await withTempProject(async cwd => {
      const fake = createFakeLLM([
        assistantToolCall("bash", {command: "node -e \"console.log('START'); console.log('z'.repeat(20000)); console.log('ERR_ASSERTION at game.test.ts:93'); console.log('z'.repeat(20000)); console.log('FAIL: 1 test'); process.exitCode=1\""}, "failed-test"),
        options => {
          const result = options.messages.find(message => message.role === "tool" && message.tool_call_id === "failed-test");
          const content = contentText(result?.content);
          expect(content).toContain("exit code 1");
          expect(content).toContain("START");
          expect(content).toContain("FAIL: 1 test");
          expect(content).not.toContain("ERR_ASSERTION");
          const path = content.match(/^Full output saved at: (.+)$/m)?.[1];
          expect(path).toBeDefined();
          return assistantToolCall("bash", {command: `rg -n -e ERR_ASSERTION '${JSON.parse(path!)}'`}, "find-assertion");
        },
        options => {
          const result = options.messages.find(message => message.role === "tool" && message.tool_call_id === "find-assertion");
          expect(result?.content).toContain("3:ERR_ASSERTION at game.test.ts:93");
          return assistantText("已定位断言");
        },
      ]);
      const history: Message[] = [{role: "system", content: "system"}];
      const result = await runAgent("定位失败", history, () => {}, createTestContext(cwd), {callLLM: fake.callLLM});
      expect(result.reply).toBe("已定位断言");
      const bashCalls = history.flatMap(message => message.role === "assistant" ? message.tool_calls ?? [] : []).filter(call => call.function.name === "bash");
      expect(bashCalls).toHaveLength(2);
      expect(bashCalls.filter(call => JSON.parse(call.function.arguments).command.startsWith("node -e"))).toHaveLength(1);
    });
  });
  test("模型只收到引用并能通过 read_file 恢复内容", async () => {
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
            "read_file",
            { path: JSON.parse((contentText(result?.content) ?? "").match(/^Full output saved at: (.+)$/m)![1]!), limit: 1 },
            "read-1"
          );
        },
        (options) => {
          const result = options.messages.find(
            (message) => message.role === "tool" && message.tool_call_id === "read-1"
          );
          expect(result?.content).toContain("z".repeat(100));
          expect(result?.content).toContain("Saved output:");
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
              contentText(message.content).includes("<persisted-output>")
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
          getToolSchemas: () => fixtureToolSchemas("a", "b"),
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
