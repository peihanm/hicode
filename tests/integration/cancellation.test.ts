import {contentText} from "../../src/images/content.js";
import { describe, expect, test } from "bun:test";
import { runAgentForTest as runAgent } from "../helpers/agent.js";
import { compactHistoryForTest as compactHistory } from "../helpers/compact.js";
import {
  abortableDelay,
  createTurnAbortController,
} from "../../src/runtime/abort.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { Message, ToolCall } from "../../src/llm/types.js";
import { assistantText, createFakeLLM } from "../helpers/fakeLLM.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";

function history(): Message[] {
  return [{ role: "system", content: "test system" }];
}

function waitForStart(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

describe("runtime cancellation", () => {
  test("等待模型时取消返回 interrupted 且不伪造 assistant", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const started = waitForStart();
      const events: AgentEvent[] = [];
      const messages = history();
      const fake = createFakeLLM([
        async (options) => {
          started.resolve();
          await abortableDelay(10_000, options.signal!);
          return assistantText("不应到达");
        },
      ]);

      const running = runAgent(
        "取消模型",
        messages,
        (event) => events.push(event),
        createTestContext(cwd, { signal: controller.signal }),
        { callLLM: fake.callLLM }
      );
      await started.promise;
      controller.abort("user-cancel");

      const result = await running;
      expect(result).toEqual({
        reply: "(任务已取消)",
        reason: "interrupted",
        iterations: 1,
        abortReason: "user-cancel",
      });
      expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(events).toContainEqual({
        type: "turn_interrupted",
        reason: "user-cancel",
      });
    });
  });

  test("工具执行中取消会为当前和剩余 tool call 补齐结果", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const started = waitForStart();
      const calls: ToolCall[] = [
        {
          id: "cancel-1",
          type: "function",
          function: { name: "slow", arguments: "{}" },
        },
        {
          id: "cancel-2",
          type: "function",
          function: { name: "never-start", arguments: "{}" },
        },
      ];
      const fake = createFakeLLM([
        {
          message: { role: "assistant", content: null, tool_calls: calls },
          toolCalls: calls,
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      ]);
      const messages = history();
      const executed: string[] = [];

      const running = runAgent(
        "取消工具",
        messages,
        () => {},
        createTestContext(cwd, { signal: controller.signal }),
        {
          callLLM: fake.callLLM,
          executeTool: async (name, _args, ctx) => {
            executed.push(name);
            started.resolve();
            await abortableDelay(10_000, ctx.signal);
            return "不应到达";
          },
        }
      );
      await started.promise;
      controller.abort("user-cancel");

      const result = await running;
      const toolMessages = messages.filter(
        (message): message is Extract<Message, { role: "tool" }> =>
          message.role === "tool"
      );
      expect(result.reason).toBe("interrupted");
      expect(executed).toEqual(["slow"]);
      expect(toolMessages.map((message) => message.tool_call_id)).toEqual([
        "cancel-1",
        "cancel-2",
      ]);
      expect(toolMessages.every((message) => contentText(message.content).includes("已取消"))).toBe(
        true
      );
    });
  });

  test("并发安全工具取消后补齐整批且不执行后续工具", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const started = waitForStart();
      const calls: ToolCall[] = ["safe-1", "safe-2", "unsafe-tail"].map((name) => ({
        id: name,
        type: "function",
        function: { name, arguments: "{}" },
      }));
      const fake = createFakeLLM([
        {
          message: { role: "assistant", content: null, tool_calls: calls },
          toolCalls: calls,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]);
      const messages = history();
      const executed: string[] = [];

      const running = runAgent(
        "取消并发工具",
        messages,
        () => {},
        createTestContext(cwd, { signal: controller.signal }),
        {
          callLLM: fake.callLLM,
          isToolConcurrencySafe: (name) => name.startsWith("safe-"),
          executeTool: async (name, _args, ctx) => {
            executed.push(name);
            if (executed.length === 2) started.resolve();
            await abortableDelay(10_000, ctx.signal);
            return "不应到达";
          },
        }
      );
      await started.promise;
      controller.abort("user-cancel");

      const result = await running;
      const toolMessages = messages.filter(
        (message): message is Extract<Message, { role: "tool" }> =>
          message.role === "tool"
      );
      expect(result.reason).toBe("interrupted");
      expect(executed.sort()).toEqual(["safe-1", "safe-2"]);
      expect(toolMessages.map((message) => message.tool_call_id)).toEqual([
        "safe-1",
        "safe-2",
        "unsafe-tail",
      ]);
      expect(toolMessages.every((message) => contentText(message.content).includes("已取消"))).toBe(
        true
      );
    });
  });

  test("Compact 取消不修改 history 也不累计失败", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const started = waitForStart();
      const messages: Message[] = [
        { role: "system", content: "system" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ];
      const before = structuredClone(messages);
      const ctx = createTestContext(cwd, { signal: controller.signal });
      const fake = createFakeLLM([
        async (options) => {
          started.resolve();
          await abortableDelay(10_000, options.signal!);
          return assistantText("不应到达");
        },
      ]);

      const running = compactHistory({
        history: messages,
        ctx,
        tools: [],
        preTokenCount: 100_000,
        force: true,
        trigger: "auto",
        callLLM: fake.callLLM,
      });
      await started.promise;
      controller.abort("user-cancel");

      await expect(running).rejects.toMatchObject({
        name: "TurnInterruptedError",
        reason: "user-cancel",
      });
      expect(messages).toEqual(before);
      expect(ctx.compactState.consecutiveFailures).toBe(0);
    });
  });

  test("取消后的同一 history 可以继续下一轮", async () => {
    await withTempProject(async (cwd) => {
      const firstController = createTurnAbortController();
      firstController.abort("user-cancel");
      const messages = history();
      const first = await runAgent(
        "第一轮",
        messages,
        () => {},
        createTestContext(cwd, { signal: firstController.signal }),
        { callLLM: createFakeLLM([]).callLLM }
      );
      expect(first.reason).toBe("interrupted");

      const secondFake = createFakeLLM([assistantText("恢复成功")]);
      const second = await runAgent(
        "第二轮",
        messages,
        () => {},
        createTestContext(cwd),
        { callLLM: secondFake.callLLM }
      );
      expect(second.reason).toBe("completed");
      expect(second.reply).toBe("恢复成功");
      expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
    });
  });

  test("非取消工具异常也会补齐所有 tool result", async () => {
    await withTempProject(async (cwd) => {
      const calls: ToolCall[] = [
        {
          id: "failed-1",
          type: "function",
          function: { name: "broken", arguments: "{}" },
        },
        {
          id: "failed-2",
          type: "function",
          function: { name: "not-started", arguments: "{}" },
        },
      ];
      const fake = createFakeLLM([
        {
          message: { role: "assistant", content: null, tool_calls: calls },
          toolCalls: calls,
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      ]);
      const messages = history();

      const running = runAgent(
        "触发异常",
        messages,
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => {
            throw new Error("runner exploded");
          },
        }
      );

      await expect(running).rejects.toThrow("runner exploded");
      const toolMessages = messages.filter(
        (message): message is Extract<Message, { role: "tool" }> =>
          message.role === "tool"
      );
      expect(toolMessages.map((message) => message.tool_call_id)).toEqual([
        "failed-1",
        "failed-2",
      ]);
      expect(
        toolMessages.every((message) => contentText(message.content).includes("runner exploded"))
      ).toBe(true);
    });
  });
});
