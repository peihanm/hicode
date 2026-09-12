import { describe, expect, test } from "bun:test";
import { runAgentForTest as runAgent } from "../helpers/agent.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { Message } from "../../src/llm/types.js";
import {
  assistantText,
  assistantToolCall,
  createFakeLLM,
} from "../helpers/fakeLLM.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";
import { attachSubagentLauncher } from "../helpers/subagentLauncher.js";

function initialHistory(): Message[] {
  return [{ role: "system", content: "test system prompt" }];
}

describe("root task ownership", () => {
  test("运行时文件修改不会由 Root 规则自动启动子 Agent", async () => {
    await withTempProject(async (cwd) => {
      const main = createFakeLLM([
        assistantToolCall(
          "write_file",
          {
            path: "xiangqi_blind.html",
            content: "<!doctype html><title>Blind Xiangqi</title>",
          },
          "write-game"
        ),
        assistantText("单文件游戏已完成并由主 Agent 检查"),
      ]);
      const ctx = createTestContext(cwd);
      let subagentCalls = 0;
      attachSubagentLauncher(ctx, async () => {
        subagentCalls += 1;
        throw new Error("Root 不应自动启动子 Agent");
      });
      const events: AgentEvent[] = [];

      const result = await runAgent(
        "写一个单文件 Web 游戏",
        initialHistory(),
        (event) => events.push(event),
        ctx,
        { callLLM: main.callLLM }
      );

      expect(result.reply).toBe("单文件游戏已完成并由主 Agent 检查");
      expect(subagentCalls).toBe(0);
      expect(
        events.some(
          (event) =>
            event.type === "tool_call_start" && event.name === "agent"
        )
      ).toBe(false);
    });
  });

  test("后台服务不会由 Root 规则自动启动子 Agent", async () => {
    await withTempProject(async (cwd) => {
      const main = createFakeLLM([
        assistantToolCall(
          "bash",
          { command: "python3 app.py", run_in_background: true },
          "start-server"
        ),
        assistantText("服务启动结果已由主 Agent 检查"),
      ]);
      const ctx = createTestContext(cwd);
      let subagentCalls = 0;
      attachSubagentLauncher(ctx, async () => {
        subagentCalls += 1;
        throw new Error("Root 不应自动启动子 Agent");
      });

      const result = await runAgent(
        "启动本地服务",
        initialHistory(),
        () => {},
        ctx,
        {
          callLLM: main.callLLM,
          executeTool: async () => ({
            modelContent: "Background task started.Task: server-1",
            displayContent: "Background task started.Task: server-1",
            outcome: "ok",
          }),
        }
      );

      expect(result.reply).toBe("服务启动结果已由主 Agent 检查");
      expect(subagentCalls).toBe(0);
    });
  });

  test("用户提到验证也不会绕过模型直接调度子 Agent", async () => {
    await withTempProject(async (cwd) => {
      const main = createFakeLLM([assistantText("主 Agent 已直接运行相关检查")]);
      const ctx = createTestContext(cwd);
      let subagentCalls = 0;
      attachSubagentLauncher(ctx, async () => {
        subagentCalls += 1;
        throw new Error("只有模型发出 agent tool call 才能启动子 Agent");
      });

      const result = await runAgent(
        "请验证这个小改动",
        initialHistory(),
        () => {},
        ctx,
        { callLLM: main.callLLM }
      );

      expect(result.reply).toBe("主 Agent 已直接运行相关检查");
      expect(subagentCalls).toBe(0);
    });
  });
});
