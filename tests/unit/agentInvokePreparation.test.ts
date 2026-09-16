import { describe, expect, test } from "bun:test";
import { prepareAgentInvoke } from "../../src/agent/invokePreparation.js";
import { tokenCountWithEstimation } from "../../src/context/tokens.js";
import { getUserContextBlocks } from "../../src/prompt/attachments.js";
import { buildInvokeMessages } from "../../src/prompt/invokeMessages.js";
import {
  createTurnAbortController,
  throwIfTurnAborted,
} from "../../src/runtime/abort.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { Message, OpenAITool } from "../../src/llm/types.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";
import { getAutoCompactThreshold } from "../../src/context/window.js";

function history(overThreshold = false): Message[] {
  return [
    { role: "system", content: "system" },
    ...(overThreshold
      ? [{role: "user" as const, origin: "user" as const, content: "x".repeat(
          getAutoCompactThreshold("glm-test") * 2 + 100
        )}]
      : []),
    { role: "user", origin: "user" as const, content: "real user message" },
  ];
}

function tool(description = "test tool"): OpenAITool {
  return {
    type: "function",
    function: {
      name: "test_tool",
      description,
      parameters: { type: "object", properties: {} },
    },
  };
}

function noCompactResult(preTokenCount: number, message?: string) {
  return {
    compacted: false,
    preTokenCount,
    threshold: getAutoCompactThreshold("glm-test"),
    ...(message ? { message } : {}),
  };
}

describe("Agent invoke preparation", () => {
  test("无 Compact 时构造临时 userContext、复用 schemas 且不修改 History", async () => {
    await withTempProject(async (cwd) => {
      const messages = history();
      const before = structuredClone(messages);
      const tools = [tool()];
      const events: AgentEvent[] = [];
      let schemaCalls = 0;
      let compactCalls = 0;

      const result = await prepareAgentInvoke({
        history: messages,
        ctx: createTestContext(cwd, {
          instructions: {
            files: [{
              path: `${cwd}/HICODE.md`,
              scope: "project",
              content: "use bun for tests",
              truncated: false,
            }],
            issues: [],
          },
        }),
        onEvent: (event) => {
          events.push(event);
        },
        getToolSchemas: () => {
          schemaCalls += 1;
          return tools;
        },
        compactHistory: async ({ preTokenCount }) => {
          compactCalls += 1;
          return noCompactResult(preTokenCount);
        },
      });

      expect(schemaCalls).toBe(1);
      expect(compactCalls).toBe(0);
      expect(result.tools).toBe(tools);
      expect(result.invokeMessages.map((message) => message.role)).toEqual([
        "system",
        "user",
        "user",
      ]);
      expect(result.invokeMessages[1]?.content).toContain("# currentDate");
      expect(result.invokeMessages[1]?.content).toContain("use bun for tests");
      expect(messages.some((message) =>
        typeof message.content === "string" &&
        message.content.includes("use bun for tests")
      )).toBe(false);
      expect(result.invokeMessages[2]?.content).toBe("real user message");
      expect(messages).toEqual(before);
      expect(events).toEqual([]);
    });
  });

  test("Tool schemas 计入估算并可以单独触发 Auto-Compact", async () => {
    await withTempProject(async (cwd) => {
      const messages = history();
      const ctx = createTestContext(cwd);
      const invokeMessages = buildInvokeMessages(
        messages,
        getUserContextBlocks(ctx.skills)
      );
      const messagesOnly = tokenCountWithEstimation(invokeMessages);
      let compactCalls = 0;

      await prepareAgentInvoke({
        history: messages,
        ctx,
        onEvent: () => {},
        getToolSchemas: () => [tool("x".repeat(
          getAutoCompactThreshold("glm-test") * 2
        ))],
        compactHistory: async ({ preTokenCount }) => {
          compactCalls += 1;
          expect(preTokenCount).toBeGreaterThan(messagesOnly);
          return noCompactResult(preTokenCount);
        },
      });

      expect(compactCalls).toBe(1);
    });
  });

  test("Provider 实报大窗口会阻止按默认 128K 过早 Compact", async () => {
    await withTempProject(async (cwd) => {
      let compactCalls = 0;

      await prepareAgentInvoke({
        history: history(true),
        ctx: createTestContext(cwd, {model: "qwen3.6-flash"}),
        contextWindow: 1_050_000,
        onEvent: () => {},
        getToolSchemas: () => [],
        compactHistory: async ({preTokenCount}) => {
          compactCalls += 1;
          return noCompactResult(preTokenCount);
        },
      });

      expect(compactCalls).toBe(0);
    });
  });

  test("连续失败达到熔断上限时跳过 Auto-Compact", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd);
      ctx.compactState.consecutiveFailures = 3;
      const events: AgentEvent[] = [];
      let compactCalls = 0;

      await prepareAgentInvoke({
        history: history(true),
        ctx,
        onEvent: (event) => {
          events.push(event);
        },
        getToolSchemas: () => [],
        compactHistory: async ({ preTokenCount }) => {
          compactCalls += 1;
          return noCompactResult(preTokenCount);
        },
      });

      expect(compactCalls).toBe(0);
      expect(events).toEqual([]);
    });
  });

  test("Compact 成功后用同一 schemas 重新构造并估算 invoke messages", async () => {
    await withTempProject(async (cwd) => {
      const messages = history(true);
      const ctx = createTestContext(cwd);
      const tools = [tool("schema")];
      const events: AgentEvent[] = [];
      let schemaCalls = 0;
      let compactTools: OpenAITool[] | undefined;

      const result = await prepareAgentInvoke({
        history: messages,
        ctx,
        onEvent: (event) => {
          events.push(event);
        },
        getToolSchemas: () => {
          schemaCalls += 1;
          return tools;
        },
        compactHistory: async ({ history, tools: receivedTools, preTokenCount }) => {
          compactTools = receivedTools;
          history.splice(1, history.length - 1, {
            role: "user", origin: "user" as const,
            content: "compacted history",
          });
          return {
            compacted: true,
            preTokenCount,
            postTokenCount: 999_999,
            threshold: 1,
          };
        },
      });

      expect(schemaCalls).toBe(1);
      expect(compactTools).toBe(tools);
      expect(result.tools).toBe(tools);
      expect(result.invokeMessages.some((message) => message.content === "compacted history"))
        .toBe(true);
      expect(result.invokeMessages.some((message) => message.content === "real user message"))
        .toBe(false);
      expect(events.map((event) => event.type)).toEqual([
        "compact_start",
        "compact_end",
      ]);
      const end = events.find((event) => event.type === "compact_end");
      expect(end?.postTokenCount).toBe(
        tokenCountWithEstimation(result.invokeMessages, tools)
      );
      expect(end?.postTokenCount).not.toBe(999_999);
    });
  });

  test("Compact 普通失败发送 error 并返回原 invoke messages", async () => {
    await withTempProject(async (cwd) => {
      const messages = history(true);
      const before = structuredClone(messages);
      const events: AgentEvent[] = [];

      const result = await prepareAgentInvoke({
        history: messages,
        ctx: createTestContext(cwd),
        onEvent: (event) => {
          events.push(event);
        },
        getToolSchemas: () => [],
        compactHistory: async ({ preTokenCount }) =>
          noCompactResult(preTokenCount, "network unavailable"),
      });

      expect(events.map((event) => event.type)).toEqual([
        "compact_start",
        "compact_error",
      ]);
      expect(messages).toEqual(before);
      expect(result.invokeMessages.at(-1)?.content).toBe("real user message");
    });
  });

  test("Compact false 且没有 message 时保持只有 start 事件", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];

      await prepareAgentInvoke({
        history: history(true),
        ctx: createTestContext(cwd),
        onEvent: (event) => {
          events.push(event);
        },
        getToolSchemas: () => [],
        compactHistory: async ({ preTokenCount }) => noCompactResult(preTokenCount),
      });

      expect(events.map((event) => event.type)).toEqual(["compact_start"]);
    });
  });

  test("Compact 取消向顶层传播且 preparation 不发送 turn event", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const ctx = createTestContext(cwd, { signal: controller.signal });
      const messages = history(true);
      const before = structuredClone(messages);
      const events: AgentEvent[] = [];

      await expect(prepareAgentInvoke({
        history: messages,
        ctx,
        onEvent: (event) => {
          events.push(event);
        },
        getToolSchemas: () => [],
        compactHistory: async () => {
          controller.abort("user-cancel");
          throwIfTurnAborted(controller.signal);
          throw new Error("unreachable");
        },
      })).rejects.toMatchObject({
        name: "TurnInterruptedError",
        reason: "user-cancel",
      });

      expect(messages).toEqual(before);
      expect(ctx.compactState.consecutiveFailures).toBe(0);
      expect(events.map((event) => event.type)).toEqual(["compact_start"]);
      expect(events.some((event) => event.type === "turn_interrupted")).toBe(false);
    });
  });
});

test("实际请求准备使用配置阈值，DeepSeek 默认不会在 95k 压缩", async () => {
  await withTempProject(async cwd => {
    for (const limit of [450_000, 80_000]) {
      const ctx = createTestContext(cwd, {model: "deepseek-flash", provider: "deepseek",
        contextSettings: {windowTokens: 500_000, autoCompactTokenLimit: limit}});
      const events: AgentEvent[] = [];
      let compactions = 0;
      await prepareAgentInvoke({ctx, history: history(true), onEvent: event => {events.push(event);}, getToolSchemas: () => [],
        compactHistory: async ({preTokenCount}) => {
          compactions++;
          return {compacted: false, preTokenCount, threshold: limit, message: "fixture preserved history"};
        }});
      expect(compactions).toBe(limit === 450_000 ? 0 : 1);
      if (compactions) expect(events[0]).toMatchObject({type: "compact_start", threshold: 80_000});
    }
  });
});
