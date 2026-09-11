import {createWriterRegistry} from "../helpers/writerAgent.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {createAgentTool} from "../../src/tools/agent/agent.js";
import {contentText} from "../../src/images/content.js";
import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { runAgentForTest as runAgent } from "../helpers/agent.js";
import {
  createSubagentRunnerForTest as createSubagentRunner,
} from "../helpers/subagent.js";
import { abortableDelay, createTurnAbortController } from "../../src/runtime/abort.js";
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
import { executeToolResult } from "../helpers/executeTool.js";

describe("synchronous subagent", () => {
  test("FixtureWriter 只在 Root 启动时确认一次并使用结构化文件工具", async () => {
    await withTempProject(async (cwd) => {
      let confirmations = 0;
      const child = createFakeLLM([
        (options) => {
          expect(options.model).toBe("glm-test");
          const names = options.tools.map((tool) => tool.function.name);
          expect(names).toContain("write_file");
          expect(names).not.toContain("bash");
          expect(names).not.toContain("agent");
          expect(names).not.toContain("task");
          return assistantToolCall(
            "write_file",
            {path: "general-purpose.txt", content: "implemented\n"},
            "general-write"
          );
        },
        (options) => {
          expect(options.messages.find((message) =>
            message.role === "tool" &&
            message.tool_call_id === "general-write"
          )?.content).toContain("已写入 general-purpose.txt");
          return assistantText("结构化文件修改完成，测试尚未运行。");
        },
      ]);
      const ctx = createTestContext(cwd, {
        permissionMode: "ask",
        collaborationMode: "build",
        canUseTool: async () => {
          confirmations += 1;
          return {behavior: "allow"};
        },
      });
      const runner = createSubagentRunner({
        registry: createWriterRegistry(),
        parentContext: ctx,
        onEvent: () => {},
        agentOptions: {callLLM: child.callLLM},
        toolResultStoreOptions: {pillarHome: `${cwd}/tool-results`},
      });
      attachSubagentLauncher(ctx, runner);

      const result = await createToolRuntime({toolOverrides: [createAgentTool(createWriterRegistry())]}).executeTool(
        "agent",
        JSON.stringify({
          description: "实现小文件",
          prompt: "创建 general-purpose.txt",
          subagent_type: "FixtureWriter",
        }),
        ctx,
        "general-purpose-call"
      );

      expect(result.outcome).toBe("ok");
      expect(confirmations).toBe(1);
      expect(await readFile(`${cwd}/general-purpose.txt`, "utf8"))
        .toBe("implemented\n");
    });
  });

  test("子 Agent 不能复用父 Agent 的文件读取授权", async () => {
    await withTempProject(async (cwd) => {
      const path = `${cwd}/owned-by-parent.ts`;
      const original = "export const value = 1;\n";
      await writeFile(path, original);
      const ctx = createTestContext(cwd, {permissionMode: "ask"});
      await executeToolResult("read_file", JSON.stringify({path}), ctx, "parent-read");
      const child = createFakeLLM([
        assistantToolCall("edit_file", {
          path: "owned-by-parent.ts",
          edits: [{old_string: "value = 1",
          new_string: "value = 2"}],
        }, "child-edit-without-read"),
        (options) => {
          const result = options.messages.find((message) =>
            message.role === "tool" &&
            message.tool_call_id === "child-edit-without-read"
          );
          expect(result?.content).toContain("必须先用 read_file");
          expect(result?.content).toContain("编辑失败");
          return assistantText("子 Agent 没有自己的读取证据，因此未修改文件。");
        },
      ]);
      const runner = createSubagentRunner({
        registry: createWriterRegistry(),
        parentContext: ctx,
        onEvent: () => {},
        agentOptions: {callLLM: child.callLLM},
        toolResultStoreOptions: {pillarHome: `${cwd}/tool-results`},
      });

      const result = await runner({
        kind: "registered",
        agentType: "FixtureWriter",
        description: "验证文件观察隔离",
        prompt: "不要读取文件，直接修改 owned-by-parent.ts",
        parentToolCallId: "parent-observation",
        workspaceWriteApproved: true,
      });

      expect(result.reply).toContain("未修改文件");
      expect(child.calls).toHaveLength(2);
      expect(await readFile(path, "utf8")).toBe(original);
    });
  });

  test("父 Agent 通过普通 tool result 获得 Explore 报告且 history 隔离", async () => {
    await withTempProject(async (cwd) => {
      await writeFile(`${cwd}/target.ts`, "export const target = 42;\n");
      const child = createFakeLLM([
        (options) => {
          expect(options.model).toBe("glm-fast-test");
          return assistantToolCall(
            "read_file",
            { path: "target.ts", offset: 1, limit: 20 },
            "child-read"
          );
        },
        (options) => {
          expect(
            options.messages.some((message) =>
              typeof message.content === "string" &&
              contentText(message.content).includes("root-only CODE instruction")
            )
          ).toBe(false);
          expect(options.tools.map((tool) => tool.function.name)).toEqual([
            "list_files",
            "read_file",
            "grep",
            "glob",
          ]);
          expect(
            options.messages.some(
              (message) =>
                message.role === "tool" && message.tool_call_id === "child-read"
            )
          ).toBe(true);
          return assistantText("证据：target.ts 导出 target 常量。");
        },
      ]);
      const parent = createFakeLLM([
        assistantToolCall(
          "agent",
          {
            description: "调查 target",
            prompt: "读取 target.ts，说明它导出了什么，并给出文件证据。",
            subagent_type: "Explore",
          },
          "parent-agent-call"
        ),
        (options) => {
          const result = options.messages.find(
            (message) =>
              message.role === "tool" &&
              message.tool_call_id === "parent-agent-call"
          );
          expect(result?.content).toContain("target.ts 导出 target 常量");
          expect(
            options.messages.some(
              (message) =>
                message.role === "tool" && message.tool_call_id === "child-read"
            )
          ).toBe(false);
          return assistantText("父 Agent 已收到调查结果");
        },
      ]);
      const ctx = createTestContext(cwd, {
        sessionId: "parent-session",
        instructions: {
          files: [{
            path: `${cwd}/PILLAR.md`,
            scope: "project",
            content: "root-only CODE instruction",
            truncated: false,
          }],
          issues: [],
        },
      });
      const events: AgentEvent[] = [];
      attachSubagentLauncher(ctx, createSubagentRunner({
        parentContext: ctx,
        onEvent: (event) => {
          events.push(event);
        },
        agentOptions: { callLLM: child.callLLM },
        toolResultStoreOptions: { pillarHome: `${cwd}/tool-results` },
      }));
      const history: Message[] = [{ role: "system", content: "parent system" }];

      const result = await runAgent(
        "请调查 target",
        history,
        () => {},
        ctx,
        { callLLM: parent.callLLM }
      );

      expect(result.reply).toBe("父 Agent 已收到调查结果");
      expect(history.some((message) => message.role === "system" && contentText(message.content).includes("只读代码探索"))).toBe(false);
      expect(events.map((event) => event.type)).toEqual([
        "subagent_start",
        "subagent_progress",
        "subagent_progress",
        "subagent_progress",
        "subagent_progress",
        "subagent_end",
      ]);
      const end = events.find((event) => event.type === "subagent_end");
      expect(end?.type === "subagent_end" && end.transcriptPath).toBeTruthy();
      if (end?.type === "subagent_end" && end.transcriptPath) {
        const transcript = await readFile(end.transcriptPath, "utf8");
        expect(transcript).toContain('"type":"start"');
        expect(transcript).toContain('"type":"snapshot"');
        expect(transcript).toContain("child-read");
      }
    });
  });

  test("父 signal 取消会中断正在请求模型的 Explore", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });
      const child = createFakeLLM([
        async (options) => {
          started();
          await abortableDelay(10_000, options.signal!);
          return assistantText("不应到达");
        },
      ]);
      const ctx = createTestContext(cwd, { signal: controller.signal });
      const events: AgentEvent[] = [];
      const runner = createSubagentRunner({
        registry: createWriterRegistry(),
        parentContext: ctx,
        onEvent: (event) => {
          events.push(event);
        },
        agentOptions: { callLLM: child.callLLM },
        toolResultStoreOptions: { pillarHome: `${cwd}/tool-results` },
      });

      const running = runner({
        kind: "registered",
        agentType: "Explore",
        description: "等待取消",
        prompt: "调查长任务",
        parentToolCallId: "parent-call",
      });
      await didStart;
      controller.abort("user-cancel");
      const result = await running;

      expect(result.reason).toBe("interrupted");
      expect(events.map((event) => event.type)).toEqual([
        "subagent_start",
        "subagent_end",
      ]);
    });
  });

  test("父 ask 规则在非交互 child 中收窄为拒绝且不改变父状态", async () => {
    await withTempProject(async (cwd) => {
      await writeFile(`${cwd}/guarded.ts`, "export const guarded = true;\n");
      const child = createFakeLLM([
        assistantToolCall("read_file", { path: "guarded.ts" }, "guarded-read"),
        (options) => {
          const toolResult = options.messages.find(
            (message) =>
              message.role === "tool" && message.tool_call_id === "guarded-read"
          );
          expect(toolResult?.content).toContain("当前 Host 不支持权限交互");
          return assistantText("读取被父规则收窄");
        },
      ]);
      const ctx = createTestContext(cwd);
      ctx.permissionRules.ask.push({
        toolName: "read_file",
        source: "project",
      });
      const originalMode = ctx.permissionMode;
      const runner = createSubagentRunner({
        registry: createWriterRegistry(),
        parentContext: ctx,
        onEvent: () => {},
        agentOptions: { callLLM: child.callLLM },
        toolResultStoreOptions: { pillarHome: `${cwd}/tool-results` },
      });

      const result = await runner({
        kind: "registered",
        agentType: "Explore",
        description: "权限收窄",
        prompt: "读取 guarded.ts",
        parentToolCallId: "parent-call",
      });
      expect(result.reply).toBe("读取被父规则收窄");
      expect(ctx.permissionMode).toBe(originalMode);
      expect(ctx.permissionRules.ask).toHaveLength(1);
    });
  });

  test("Explore 继承主安全上限并保留最后一次无工具总结", async () => {
    await withTempProject(async (cwd) => {
      await writeFile(`${cwd}/loop.ts`, "export {};\n");
      const child = createFakeLLM(
        [
          ...Array.from({ length: 29 }, (_, index) =>
            assistantToolCall(
              "read_file",
              { path: "loop.ts" },
              `loop-read-${index}`
            )
          ),
          (options) => {
            expect(options.tools).toEqual([]);
            expect(
              options.messages.some(
                (message) =>
                  message.role === "user" &&
                  contentText(message.content).includes("工具调查阶段已经结束")
              )
            ).toBe(true);
            return assistantText("根据已有证据完成最终报告");
          },
        ]
      );
      const ctx = createTestContext(cwd);
      const runner = createSubagentRunner({
        registry: createWriterRegistry(),
        parentContext: ctx,
        onEvent: () => {},
        agentOptions: { callLLM: child.callLLM },
        toolResultStoreOptions: { pillarHome: `${cwd}/tool-results` },
      });
      const result = await runner({
        kind: "registered",
        agentType: "Explore",
        description: "轮次上限",
        prompt: "持续读取",
        parentToolCallId: "parent-call",
      });

      expect(result.reason).toBe("completed");
      expect(result.reply).toBe("根据已有证据完成最终报告");
      expect(result.iterations).toBe(30);
      expect(child.calls).toHaveLength(30);
    });
  });

  test("transcript 不可写时仍返回已生成报告", async () => {
    await withTempProject(async (cwd, storage) => {
      await writeFile(storage.pillarHome, "阻止创建 transcript 目录");
      const child = createFakeLLM([assistantText("仍然完成调查")]);
      const ctx = createTestContext(cwd);
      const runner = createSubagentRunner({
        registry: createWriterRegistry(),
        parentContext: ctx,
        onEvent: () => {},
        agentOptions: { callLLM: child.callLLM },
        toolResultStoreOptions: { pillarHome: `${cwd}/tool-results` },
      });
      const result = await runner({
        kind: "registered",
        agentType: "Explore",
        description: "transcript 降级",
        prompt: "返回报告",
        parentToolCallId: "parent-call",
      });

      expect(result.reply).toBe("仍然完成调查");
      expect(result.reason).toBe("completed");
      expect(result.transcriptPath).toBeUndefined();
    });
  });
});
