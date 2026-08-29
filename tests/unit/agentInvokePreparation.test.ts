import { afterEach, describe, expect, test } from "bun:test";
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

const originalThreshold = process.env.AUTO_COMPACT_THRESHOLD;
const originalDisableCompact = process.env.DISABLE_COMPACT;
const originalDisableAutoCompact = process.env.DISABLE_AUTO_COMPACT;

afterEach(() => {
  if (originalThreshold === undefined) delete process.env.AUTO_COMPACT_THRESHOLD;
  else process.env.AUTO_COMPACT_THRESHOLD = originalThreshold;
  if (originalDisableCompact === undefined) delete process.env.DISABLE_COMPACT;
  else process.env.DISABLE_COMPACT = originalDisableCompact;
  if (originalDisableAutoCompact === undefined) delete process.env.DISABLE_AUTO_COMPACT;
  else process.env.DISABLE_AUTO_COMPACT = originalDisableAutoCompact;
});

function history(): Message[] {
  return [
    { role: "system", content: "system" },
    { role: "user", content: "real user message" },
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
    threshold: Number(process.env.AUTO_COMPACT_THRESHOLD ?? 1),
    ...(message ? { message } : {}),
  };
}

describe("Agent invoke preparation", () => {
  test("无 Compact 时构造临时 userContext、复用 schemas 且不修改 History", async () => {
    await withTempProject(async (cwd) => {
      process.env.AUTO_COMPACT_THRESHOLD = "1000000";
      delete process.env.DISABLE_COMPACT;
      delete process.env.DISABLE_AUTO_COMPACT;
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
              path: `${cwd}/CODE.md`,
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
      delete process.env.DISABLE_COMPACT;
      delete process.env.DISABLE_AUTO_COMPACT;
      const messages = history();
      const ctx = createTestContext(cwd);
      const invokeMessages = buildInvokeMessages(
        messages,
        getUserContextBlocks(ctx.skills)
      );
      const messagesOnly = tokenCountWithEstimation(invokeMessages);
      process.env.AUTO_COMPACT_THRESHOLD = String(messagesOnly + 1);
      let compactCalls = 0;

      await prepareAgentInvoke({
        history: messages,
        ctx,
        onEvent: () => {},
        getToolSchemas: () => [tool("x".repeat(2_000))],
        compactHistory: async ({ preTokenCount }) => {
          compactCalls += 1;
          expect(preTokenCount).toBeGreaterThan(messagesOnly);
          return noCompactResult(preTokenCount);
        },
      });

      expect(compactCalls).toBe(1);
    });
  });

  test("两个禁用环境变量都阻止 Auto-Compact", async () => {
    await withTempProject(async (cwd) => {
      process.env.AUTO_COMPACT_THRESHOLD = "1";
      let compactCalls = 0;
      const runWith = async (name: "DISABLE_COMPACT" | "DISABLE_AUTO_COMPACT") => {
        delete process.env.DISABLE_COMPACT;
        delete process.env.DISABLE_AUTO_COMPACT;
        process.env[name] = "1";
        await prepareAgentInvoke({
          history: history(),
          ctx: createTestContext(cwd),
          onEvent: () => {},
          getToolSchemas: () => [],
          compactHistory: async ({ preTokenCount }) => {
            compactCalls += 1;
            return noCompactResult(preTokenCount);
          },
        });
      };

      await runWith("DISABLE_COMPACT");
      await runWith("DISABLE_AUTO_COMPACT");
      expect(compactCalls).toBe(0);
    });
  });

  test("连续失败达到熔断上限时跳过 Auto-Compact", async () => {
    await withTempProject(async (cwd) => {
      process.env.AUTO_COMPACT_THRESHOLD = "1";
      delete process.env.DISABLE_COMPACT;
      delete process.env.DISABLE_AUTO_COMPACT;
      const ctx = createTestContext(cwd);
      ctx.compactState.consecutiveFailures = 3;
      const events: AgentEvent[] = [];
      let compactCalls = 0;

      await prepareAgentInvoke({
        history: history(),
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
      process.env.AUTO_COMPACT_THRESHOLD = "1";
      delete process.env.DISABLE_COMPACT;
      delete process.env.DISABLE_AUTO_COMPACT;
      const messages = history();
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
            role: "user",
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
      process.env.AUTO_COMPACT_THRESHOLD = "1";
      delete process.env.DISABLE_COMPACT;
      delete process.env.DISABLE_AUTO_COMPACT;
      const messages = history();
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
      process.env.AUTO_COMPACT_THRESHOLD = "1";
      delete process.env.DISABLE_COMPACT;
      delete process.env.DISABLE_AUTO_COMPACT;
      const events: AgentEvent[] = [];

      await prepareAgentInvoke({
        history: history(),
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
      process.env.AUTO_COMPACT_THRESHOLD = "1";
      delete process.env.DISABLE_COMPACT;
      delete process.env.DISABLE_AUTO_COMPACT;
      const controller = createTurnAbortController();
      const ctx = createTestContext(cwd, { signal: controller.signal });
      const messages = history();
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
