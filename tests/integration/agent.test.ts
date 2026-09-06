import { describe, expect, test } from "bun:test";
import { runAgentForTest as runAgent } from "../helpers/agent.js";
import type { LLMCaller } from "../../src/llm/types.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { Message, ToolCall } from "../../src/llm/types.js";
import {
  assistantText,
  assistantToolCall,
  createFakeLLM,
} from "../helpers/fakeLLM.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createFileChange } from "../../src/fileChanges/index.js";

function initialHistory(): Message[] {
  return [{ role: "system", content: "test system prompt" }];
}

function assistantToolCalls(calls: ToolCall[]) {
  return {
    message: { role: "assistant" as const, content: null, tool_calls: calls },
    toolCalls: calls,
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
  };
}

describe("agent loop", () => {
  test("带工具调用的 Assistant 正文作为 commentary 在工具前显示", async () => {
    await withTempProject(async (cwd) => {
      const history = initialHistory();
      const events: AgentEvent[] = [];
      const fake = createFakeLLM([
        assistantToolCall(
          "read_file",
          {path: "README.md"},
          "commentary-read",
          "我已经定位到入口，接下来读取配置。"
        ),
        assistantText("检查完成"),
      ]);

      const result = await runAgent(
        "检查项目",
        history,
        (event) => events.push(event),
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => "读取完成",
        }
      );

      expect(result.reply).toBe("检查完成");
      const visible = events.filter(
        (event) =>
          event.type === "assistant_text" || event.type === "tool_call_start"
      );
      expect(visible.slice(0, 2)).toEqual([
        {
          type: "assistant_text",
          content: "我已经定位到入口，接下来读取配置。",
          phase: "commentary",
        },
        expect.objectContaining({
          type: "tool_call_start",
          toolCallId: "commentary-read",
        }),
      ]);
      expect(visible.at(-1)).toEqual({
        type: "assistant_text",
        content: "检查完成",
        phase: "final",
      });
      expect(history).toContainEqual(expect.objectContaining({
        role: "assistant",
        content: "我已经定位到入口，接下来读取配置。",
      }));
    });
  });

  test("同一 root turn 的文件修改事件携带稳定 turnId 和 uiData", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];
      const change = createFileChange({
        path: "a.ts",
        kind: "update",
        oldContent: "a\n",
        newContent: "b\n",
      });
      const fake = createFakeLLM([
        assistantToolCall("edit_file", {}, "edit-event"),
        assistantText("完成"),
      ]);
      await runAgent(
        "修改",
        initialHistory(),
        (event) => events.push(event),
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => ({
            modelContent: "已修改",
            displayContent: "已修改",
            outcome: "ok",
            uiData: { type: "file_change", change },
          }),
        }
      );

      const start = events.find((event) => event.type === "tool_call_start");
      const end = events.find((event) => event.type === "tool_call_end");
      if (start?.type === "tool_call_start" && end?.type === "tool_call_end") {
        expect(typeof start.turnId).toBe("string");
        expect(end.turnId).toBe(start.turnId);
        expect(end.uiData).toMatchObject({
          type: "file_change",
          change: {path: "a.ts"},
        });
      }
    });
  });
  test("无工具调用时返回最终文本并记录事件", async () => {
    await withTempProject(async (cwd) => {
      const history = initialHistory();
      const events: AgentEvent[] = [];
      const fake = createFakeLLM([assistantText("任务完成")]);

      const result = await runAgent(
        "处理任务",
        history,
        (event) => events.push(event),
        createTestContext(cwd),
        { callLLM: fake.callLLM }
      );

      expect(result).toEqual({
        reply: "任务完成",
        reason: "completed",
        iterations: 1,
        usage: {
          inputTokens: 12,
          outputTokens: 4,
          totalTokens: 16,
          estimated: false,
        },
      });
      expect(history.map((message) => message.role)).toEqual([
        "system",
        "user",
        "assistant",
      ]);
      expect(events.some((event) => event.type === "assistant_text")).toBe(true);
      expect(events.some((event) => event.type === "token_update")).toBe(true);
      expect(fake.calls).toHaveLength(1);
    });
  });

  test("Provider 缺失 usage 时用本地上下文估算，不发布真实零 token", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];
      await runAgent(
        "处理任务",
        initialHistory(),
        (event) => events.push(event),
        createTestContext(cwd),
        {
          callLLM: async () => ({
            message: { role: "assistant", content: "完成" },
            toolCalls: [],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          }),
        }
      );

      const update = events.find((event) => event.type === "token_update");
      expect(update).toMatchObject({ type: "token_update", status: "estimated" });
      expect(update?.tokenCount).toBeGreaterThan(0);
    });
  });

  test("当前上下文驱动 TUI，累计 usage 仍用于 Agent 结果", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];
      const result = await runAgent(
        "处理任务",
        initialHistory(),
        (event) => events.push(event),
        createTestContext(cwd, {model: "qwen3.6-flash"}),
        {
          callLLM: async () => ({
            message: {role: "assistant", content: "完成"},
            toolCalls: [],
            usage: {
              prompt_tokens: 300,
              completion_tokens: 40,
              total_tokens: 340,
            },
            contextUsage: {
              tokenCount: 74,
              contextWindow: 1_050_000,
            },
          }),
        }
      );

      expect(result.usage).toEqual({
        inputTokens: 300,
        outputTokens: 40,
        totalTokens: 340,
        estimated: false,
      });
      const update = events.find((event) => event.type === "token_update");
      expect(update).toMatchObject({
        type: "token_update",
        tokenCount: 74,
        status: "actual",
        warning: false,
      });
      expect(update?.percentUsed).toBeCloseTo(74 / 1_030_000, 8);
    });
  });

  test("把 Provider 的流式生成进度转发给宿主并在完成时收口", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];
      const streamingCall: LLMCaller =
        async (
          _messages,
          _tools,
          _storage,
          _cwd,
          _model,
          _kind,
          _signal,
          onStreamProgress
        ) => {
          onStreamProgress?.({
            phase: "tool_input",
            outputCharacters: 400,
            estimatedOutputTokens: 100,
            toolName: "write_file",
          });
          return assistantText("完成");
        };

      await runAgent(
        "处理任务",
        initialHistory(),
        (event) => events.push(event),
        createTestContext(cwd),
        { callLLM: streamingCall }
      );

      expect(
        events.filter((event) => event.type.startsWith("model_stream"))
      ).toEqual([
        { type: "model_stream_start" },
        {
          type: "model_stream_progress",
          phase: "tool_input",
          outputCharacters: 400,
          estimatedOutputTokens: 100,
          toolName: "write_file",
        },
        { type: "model_stream_end" },
      ]);
    });
  });

  test("模型 stream 失败时也发送 end，避免 UI 保留过期进度", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];
      const failedCall: LLMCaller =
        async (
          _messages,
          _tools,
          _storage,
          _cwd,
          _model,
          _kind,
          _signal,
          onStreamProgress
        ) => {
          onStreamProgress?.({
            phase: "content",
            outputCharacters: 40,
            estimatedOutputTokens: 10,
          });
          throw new Error("stream disconnected");
        };

      await expect(
        runAgent(
          "处理任务",
          initialHistory(),
          (event) => events.push(event),
          createTestContext(cwd),
          { callLLM: failedCall }
        )
      ).rejects.toThrow("stream disconnected");
      expect(events.at(-1)).toEqual({ type: "model_stream_end" });
    });
  });

  test("工具结果进入下一轮模型上下文并保持 call id 配对", async () => {
    await withTempProject(async (cwd) => {
      const history = initialHistory();
      const events: AgentEvent[] = [];
      const fake = createFakeLLM([
        assistantToolCall("synthetic_tool", { value: 1 }, "call-42"),
        (options) => {
          const toolResult = options.messages.find(
            (message) => message.role === "tool" && message.tool_call_id === "call-42"
          );
          expect(toolResult?.content).toBe("synthetic result");
          return assistantText("已使用工具结果");
        },
      ]);

      const result = await runAgent(
        "调用工具",
        history,
        (event) => events.push(event),
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => "synthetic result",
        }
      );

      expect(result.reason).toBe("completed");
      expect(fake.calls).toHaveLength(2);
      expect(
        history.some(
          (message) =>
            message.role === "tool" && message.tool_call_id === "call-42"
        )
      ).toBe(true);
      expect(events.map((event) => event.type)).toContain("tool_call_start");
      expect(events.map((event) => event.type)).toContain("tool_call_end");
    });
  });

  test("拒绝模型跨迭代复用历史 Tool Call ID", async () => {
    await withTempProject(async (cwd) => {
      const history = initialHistory();
      const fake = createFakeLLM([
        assistantToolCall("read_file", {path: "a.ts"}, "reused-call"),
        assistantToolCall("grep", {pattern: "x"}, "reused-call"),
      ]);
      let executions = 0;

      await expect(runAgent(
        "调查",
        history,
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => {
            executions += 1;
            return "first result";
          },
        }
      )).rejects.toThrow("重复使用历史 Tool Call ID");
      expect(executions).toBe(1);
      expect(history.filter((message) =>
        message.role === "assistant" &&
        message.tool_calls?.some((call) => call.id === "reused-call")
      )).toHaveLength(1);
    });
  });

  test("连续并发安全工具同时执行且按原调用顺序回写", async () => {
    await withTempProject(async (cwd) => {
      const calls: ToolCall[] = ["safe-1", "safe-2", "safe-3"].map((id) => ({
        id,
        type: "function",
        function: { name: id, arguments: "{}" },
      }));
      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fake = createFakeLLM([
        assistantToolCalls(calls),
        (options) => {
          const ids = options.messages
            .filter((message) => message.role === "tool")
            .map((message) => message.tool_call_id);
          expect(ids).toEqual(["safe-1", "safe-2", "safe-3"]);
          return assistantText("并发完成");
        },
      ]);

      const result = await runAgent(
        "并发读取",
        initialHistory(),
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          isToolConcurrencySafe: () => true,
          executeTool: async (name) => {
            arrivals += 1;
            if (arrivals === calls.length) release();
            await Promise.race([
              gate,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("工具未并发启动")), 200)
              ),
            ]);
            return `${name} result`;
          },
        }
      );

      expect(result.reply).toBe("并发完成");
      expect(arrivals).toBe(3);
    });
  });

  test("非安全工具在并发安全批次之间独占执行", async () => {
    await withTempProject(async (cwd) => {
      const names = ["read-1", "read-2", "write", "read-3", "read-4"];
      const calls: ToolCall[] = names.map((name) => ({
        id: name,
        type: "function",
        function: { name, arguments: "{}" },
      }));
      let active = 0;
      let unsafeOverlap = false;
      const activeNames = new Set<string>();
      const fake = createFakeLLM([
        assistantToolCalls(calls),
        assistantText("分批完成"),
      ]);

      await runAgent(
        "混合调用",
        initialHistory(),
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          isToolConcurrencySafe: (name) => name.startsWith("read-"),
          executeTool: async (name) => {
            if (name === "write" ? active > 0 : activeNames.has("write")) {
              unsafeOverlap = true;
            }
            active += 1;
            activeNames.add(name);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
            activeNames.delete(name);
            return `${name} result`;
          },
        }
      );

      expect(unsafeOverlap).toBe(false);
    });
  });

  test("工具失败仍作为 tool result 回喂模型", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall("broken_tool", {}, "broken-1"),
        (options) => {
          const result = options.messages.find(
            (message) => message.role === "tool" && message.tool_call_id === "broken-1"
          );
          expect(result?.content).toContain("工具执行出错");
          return assistantText("已处理失败");
        },
      ]);

      const result = await runAgent(
        "处理失败",
        initialHistory(),
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => "工具执行出错: synthetic failure",
        }
      );

      expect(result.reply).toBe("已处理失败");
    });
  });

  test("独立审查报告交给主模型处理，不由主循环追加固定结论", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall(
          "agent",
          {
            description: "独立验证",
            prompt: "检查当前实现",
            subagent_type: "project-reviewer",
          },
          "reviewer-1"
        ),
        assistantText("验证未覆盖浏览器交互，我暂时不能确认端到端通过。"),
      ]);

      const result = await runAgent(
        "验证实现",
        initialHistory(),
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => ({
            modelContent: "浏览器交互未覆盖",
            displayContent: "浏览器交互未覆盖",
            outcome: "ok",
          }),
        }
      );

      expect(result.reply).toBe(
        "验证未覆盖浏览器交互，我暂时不能确认端到端通过。"
      );
    });
  });

  test("工具失败按原始结果交给模型，可披露后直接收尾", async () => {
    await withTempProject(async (cwd) => {
      const history = initialHistory();
      const fake = createFakeLLM([
        assistantToolCall("bash", {}, "failed-bash"),
        (options) => {
          expect(options.messages.find(message => message.role === "tool" &&
            message.tool_call_id === "failed-bash")?.content).toBe("执行失败 (timeout 30000ms)");
          expect(JSON.stringify(options.messages)).not.toContain("未解决");
          return assistantText("启动验证失败，程序没有保持运行");
        },
      ]);

      const result = await runAgent(
        "启动游戏",
        history,
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => ({
            modelContent: "执行失败 (timeout 30000ms)",
            displayContent: "执行失败 (timeout 30000ms)",
            outcome: "failed",
          }),
        }
      );

      expect(result.reply).toBe("启动验证失败，程序没有保持运行");
      expect(fake.calls).toHaveLength(2);
      expect(history.some(
        (message) => message.role === "tool" && message.content === "执行失败 (timeout 30000ms)"
      )).toBe(true);
      expect(history.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("<system-reminder>")
      )).toBe(false);
    });
  });

  test.each([
    "运行中的 dev server 由当前 Pillar 会话托管，退出后需用上面的命令重启。",
    "The dev server is managed by this session; restart it after exiting.",
    "服务已启动：http://localhost:3000",
  ])("历史失败与后台服务不会因最终措辞强制返工：%s", async (reply) => {
    await withTempProject(async (cwd) => {
      const history = initialHistory();
      const events: AgentEvent[] = [];
      const lifecycle = "后台任务已启动。\nTask: server-123\nLifecycle: 由当前 Pillar Runtime 管理；退出 Pillar 后会终止。\nStatus: running";
      const fake = createFakeLLM([
        assistantToolCall("edit_file", {}, "old-edit-failure"),
        assistantToolCall("bash", {command: "node server.js", run_in_background: true}, "server-bash"),
        (options) => {
          expect(options.messages.find(message => message.role === "tool" && message.tool_call_id === "old-edit-failure")?.content).toBe("Edit 匹配失败");
          expect(options.messages.find(message => message.role === "tool" && message.tool_call_id === "server-bash")?.content).toBe(lifecycle);
          expect(JSON.stringify(options.messages)).not.toContain("当前完成证据");
          return assistantText(reply);
        },
      ]);
      const result = await runAgent("启动服务", history, event => {events.push(event);}, createTestContext(cwd), {
        callLLM: fake.callLLM,
        executeTool: async (name) => name === "edit_file"
          ? {modelContent: "Edit 匹配失败", displayContent: "Edit 匹配失败", outcome: "failed"}
          : {modelContent: lifecycle, displayContent: lifecycle, outcome: "ok"},
      });
      expect(result.reply).toBe(reply);
      expect(fake.calls).toHaveLength(3);
      expect(events.filter(event => event.type === "assistant_text").map(event => event.content)).toEqual([reply]);
      expect(history.at(-1)?.content).toBe(reply);
    });
  });

  test("最终回答前要求收口仍在进行的 Todo", async () => {
    await withTempProject(async (cwd) => {
      let todos: Array<{
        content: string;
        status: "pending" | "in_progress" | "completed";
        activeForm: string;
      }> = [];
      const activeTodo = {
        content: "补充 README 并执行构建与接口验证",
        status: "in_progress" as const,
        activeForm: "正在补充说明并验证",
      };
      const completedTodo = {...activeTodo, status: "completed" as const};
      const fake = createFakeLLM([
        assistantToolCall("todo_write", {todos: [activeTodo]}, "todo-start"),
        assistantText("网站已经完成，验证全部通过。"),
        (options) => {
          expect(options.messages.some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("仍有标记为 in_progress 的 Todo") &&
              message.content.includes(activeTodo.content) &&
              message.content.includes("先调用 todo_write 标记 completed") &&
              message.content.includes(
                "<candidate-reply>\n网站已经完成，验证全部通过。\n</candidate-reply>"
              )
          )).toBe(true);
          return assistantToolCall(
            "todo_write",
            {todos: [completedTodo]},
            "todo-complete"
          );
        },
        assistantText("网站已经完成，验证全部通过。"),
      ]);
      const ctx = createTestContext(cwd, {
        setTodos(nextTodos) {
          todos = nextTodos;
        },
      });
      const history = initialHistory();

      const result = await runAgent(
        "完成网站并验证",
        history,
        () => {},
        ctx,
        {
          callLLM: fake.callLLM,
          getTodos: () => todos,
        }
      );

      expect(result.reply).toBe("网站已经完成，验证全部通过。");
      expect(todos).toEqual([]);
      expect(fake.calls).toHaveLength(4);
      expect(history.some(
        (message) => message.content === "网站已经完成，验证全部通过。"
      )).toBe(true);
      expect(history.filter(
        (message) => message.content === "网站已经完成，验证全部通过。"
      )).toHaveLength(1);
    });
  });

  test("纠正虚假沙箱声明时不追加浏览器验收要求", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall("write_file", {
          path: "server.js",
          content: "console.log('server')",
        }, "write-server"),
        assistantToolCall("bash", {
          command: [
            "curl --fail-with-body -X POST http://localhost:3000/api/run",
            "-H 'Content-Type: application/json'",
            "-d '{\"code\":\"ok\"}'",
          ].join(" "),
        }, "curl-api"),
        assistantText("完成，全链路验证通过。后端沙箱执行用户代码。"),
        (options) => {
          expect(options.messages.some(
            (message) =>
              typeof message.content === "string" &&
              !message.content.includes("没有 Browser/Playwright 证据") &&
              message.content.includes("不是沙箱") &&
              message.content.includes(
                "<candidate-reply>\n完成，全链路验证通过。后端沙箱执行用户代码。\n</candidate-reply>"
              )
          )).toBe(true);
          return assistantText(
            "已验证一个 localhost POST 样例。浏览器交互、其他语言路径尚未验证；用户代码由本机子进程执行，仍可访问宿主文件和网络。"
          );
        },
      ]);

      const result = await runAgent(
        "创建本地代码练习站",
        initialHistory(),
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async (name, args) => ({
            modelContent: "ok",
            displayContent: "ok",
            outcome: "ok",
            ...(name === "bash" ? {shellExecution: {command: JSON.parse(args).command, cwd, sandboxPermissions: "use_default" as const}} : {}),
          }),
        }
      );

      expect(result.reply).toContain("浏览器交互、其他语言路径尚未验证");
      expect(result.reply).toContain("本机子进程执行");
      expect(result.reply).not.toContain("全链路验证通过");
      expect(fake.calls).toHaveLength(4);
    });
  });

  test.each([
    ["node --test", "五子棋算法全部测试通过，页面交互未验证。"],
    ["npm run test:e2e", "项目已有端到端测试全部通过。"],
  ])("已有 %s 证据时可以直接收尾，不因缺少浏览器工具调用追加一轮", async (command, reply) => {
    await withTempProject(async (cwd) => {
      const commands = ["curl --fail http://localhost:8765/index.html", command];
      const executed: string[] = [];
      const fake = createFakeLLM([
        ...commands.map((command, i) => assistantToolCall("bash", {command}, `check-${i}`)),
        (options) => {
          expect(options.messages.some(message => typeof message.content === "string" &&
            message.content.includes(`检查通过: ${cwd}: ${command}`))).toBe(true);
          return assistantText(reply);
        },
      ]);
      const result = await runAgent("验证本次修改", initialHistory(), () => {}, createTestContext(cwd), {
        callLLM: fake.callLLM,
        executeTool: async (name, args) => {
          expect(name).toBe("bash");
          const input = JSON.parse(args) as {command: string};
          executed.push(input.command);
          return {modelContent: "ok", displayContent: "ok", outcome: "ok",
            shellExecution: {command: input.command, cwd, sandboxPermissions: "use_default"}};
        },
      });
      expect(result.reply).toBe(reply);
      expect(fake.calls).toHaveLength(3);
      expect(executed).toEqual(commands);
    });
  });

  test("浏览器环境受阻可以披露后收尾，完成提醒不会自动重试或启动其他工具", async () => {
    await withTempProject(async (cwd) => {
      const reply = "页面交互未验证：CDP 连接失败，无法判断页面行为。";
      const invoked: string[] = [];
      const fake = createFakeLLM([
        assistantToolCall("mcp__chrome__navigate", {url: "http://localhost:8765"}, "browser-failed"),
        (options) => {
          expect(options.messages.find(message => message.role === "tool" &&
            message.tool_call_id === "browser-failed")?.content).toBe("CDP 连接失败");
          return assistantText(reply);
        },
      ]);
      const result = await runAgent("检查页面交互", initialHistory(), () => {}, createTestContext(cwd), {
        callLLM: fake.callLLM,
        executeTool: async (name) => {
          invoked.push(name);
          return {modelContent: "CDP 连接失败", displayContent: "CDP 连接失败", outcome: "failed"};
        },
      });
      expect(result.reply).toBe(reply);
      expect(invoked).toEqual(["mcp__chrome__navigate"]);
      expect(fake.calls).toHaveLength(2);
    });
  });

  test("失败和后续成功均保留原始结果，不重复注入失败或强制续跑", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLLM([
        assistantToolCall("bash", {}, "bash-failed"),
        assistantToolCall("bash", {}, "bash-passed"),
        (options) => {
          expect(options.messages.filter(message => message.role === "tool").map(message => message.content)).toEqual(["failed", "passed"]);
          expect(JSON.stringify(options.messages)).not.toContain("本轮存在失败工具记录");
          return assistantText("失败已由后续实际检查替代，重新验证通过");
        },
      ]);
      let executions = 0;

      const result = await runAgent(
        "运行验证",
        initialHistory(),
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => {
            executions += 1;
            return {
              modelContent: executions === 1 ? "failed" : "passed",
              displayContent: executions === 1 ? "failed" : "passed",
              outcome: executions === 1 ? "failed" : "ok",
            };
          },
        }
      );

      expect(result.reply).toBe("失败已由后续实际检查替代，重新验证通过");
      expect(fake.calls).toHaveLength(3);
    });
  });

  test("同一并发批次的成功和失败各自配对，不由完成门覆盖模型判断", async () => {
    await withTempProject(async (cwd) => {
      const calls: ToolCall[] = ["failed", "passed"].map((id) => ({
        id,
        type: "function",
        function: { name: "check", arguments: "{}" },
      }));
      const fake = createFakeLLM([
        assistantToolCalls(calls),
        (options) => {
          expect(options.messages.filter(message => message.role === "tool").map(message =>
            [message.tool_call_id, message.content])).toEqual([["failed", "failed"], ["passed", "passed"]]);
          return assistantText("其中一个并发检查仍然失败");
        },
      ]);

      const result = await runAgent(
        "并发检查",
        initialHistory(),
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          isToolConcurrencySafe: () => true,
          executeTool: async (_name, _args, _ctx, toolCallId) => ({
            modelContent: toolCallId,
            displayContent: toolCallId,
            outcome: toolCallId === "failed" ? "failed" : "ok",
          }),
        }
      );

      expect(result.reply).toBe("其中一个并发检查仍然失败");
      expect(fake.calls).toHaveLength(2);
    });
  });

  test("可配置 max iterations，防止无限工具循环", async () => {
    await withTempProject(async (cwd) => {
      let sequence = 0;
      const events: AgentEvent[] = [];
      const fake = createFakeLLM([
        () => assistantToolCall("loop", {}, `loop-${++sequence}`),
        () => assistantToolCall("loop", {}, `loop-${++sequence}`),
      ]);

      const result = await runAgent(
        "不要停止",
        initialHistory(),
        (event) => events.push(event),
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => "continue",
          maxIterations: 2,
        }
      );

      expect(result).toEqual({
        reply: "(达到最大迭代次数 2，已停止)",
        reason: "max_turns",
        iterations: 2,
        usage: {
          inputTokens: 24,
          outputTokens: 8,
          totalTokens: 32,
          estimated: false,
        },
      });
      expect(fake.calls).toHaveLength(2);
      expect(events).toContainEqual({
        type: "assistant_text",
        content: "(达到最大迭代次数 2，已停止)",
        phase: "final",
      });
    });
  });

  test("Root 未显式配置时不受默认迭代轮次限制", async () => {
    await withTempProject(async (cwd) => {
      const toolIterations = 35;
      const fake = createFakeLLM([
        ...Array.from({length: toolIterations}, (_, index) =>
          () => assistantToolCall("loop", {}, `unbounded-${index + 1}`)
        ),
        assistantText("任务完成"),
      ]);

      const result = await runAgent(
        "完成一个长任务",
        initialHistory(),
        () => {},
        createTestContext(cwd),
        {
          callLLM: fake.callLLM,
          executeTool: async () => "continue",
        }
      );

      expect(result.reason).toBe("completed");
      expect(result.reply).toBe("任务完成");
      expect(result.iterations).toBe(toolIterations + 1);
      expect(fake.calls).toHaveLength(toolIterations + 1);
    });
  });

  test("空 assistant 回复安全重试一次后恢复最终回答", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];
      const fake = createFakeLLM([
        assistantText(null),
        (options) => {
          expect(options.messages.some(
            (message) =>
              typeof message.content === "string" &&
              message.content.includes("上一次模型响应没有有效正文或工具调用")
          )).toBe(true);
          return assistantText("恢复后的完整回答");
        },
      ]);
      const result = await runAgent(
        "空回复",
        initialHistory(),
        (event) => events.push(event),
        createTestContext(cwd),
        { callLLM: fake.callLLM }
      );

      expect(result.reason).toBe("completed");
      expect(result.reply).toBe("恢复后的完整回答");
      expect(fake.calls).toHaveLength(2);
      expect(events.filter((event) => event.type === "assistant_text")).toHaveLength(1);
    });
  });

  test("连续空 assistant 回复向用户显示明确错误", async () => {
    await withTempProject(async (cwd) => {
      const events: AgentEvent[] = [];
      const fake = createFakeLLM([assistantText(null), assistantText("   \n")]);
      const result = await runAgent(
        "空回复",
        initialHistory(),
        (event) => events.push(event),
        createTestContext(cwd),
        { callLLM: fake.callLLM }
      );

      expect(result.reason).toBe("no_tool_calls");
      expect(result.reply).toBe("模型连续两次未返回有效正文或工具调用，已停止本轮。");
      expect(events).toContainEqual({
        type: "assistant_text",
        content: "模型连续两次未返回有效正文或工具调用，已停止本轮。",
        phase: "final",
      });
    });
  });
});
