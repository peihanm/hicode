import {contentText} from "../../src/images/content.js";
import { describe, expect, test } from "bun:test";
import { executeToolCallBatch } from "../../src/agent/toolBatch.js";
import { abortableDelay, createTurnAbortController } from "../../src/runtime/abort.js";
import type { ToolUIData } from "../../src/fileChanges/index.js";
import type { PersistedToolResult } from "../../src/toolResults/index.js";
import type { AgentEvent } from "../../src/agent/types.js";
import type { Message, ToolCall } from "../../src/llm/types.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";

function call(name: string, id = name): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: `{"name":"${name}"}` },
  };
}

function toolMessages(history: Message[]) {
  return history.filter(
    (message): message is Extract<Message, { role: "tool" }> =>
      message.role === "tool"
  );
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}

describe("Agent tool-call batch", () => {
  test("提交 model/display/outcome/persisted/uiData 并保持事件配对", async () => {
    await withTempProject(async (cwd) => {
      const history: Message[] = [];
      const events: AgentEvent[] = [];
      const ctx = createTestContext(cwd);
      const persisted: PersistedToolResult = {
        resultId: "tr_existing",
        toolCallId: "call-1",
        toolName: "edit",
        path: "/tmp/tr_existing.txt",
        byteLength: 10,
        originalByteLength: 10,
        preview: "preview",
        complete: true,
        encoding: "utf-8",
      };
      const uiData: ToolUIData = {
        type: "file_change",
        change: {
          version: 1,
          path: "a.ts",
          kind: "create",
          hunks: [],
          linesAdded: 1,
          linesRemoved: 0,
          diffStatus: "complete",
        },
      };

      const result = await executeToolCallBatch({
        toolCalls: [call("edit", "call-1")],
        history,
        ctx,
        turnId: "turn-1",
        onEvent: (event) => {
          events.push(event);
        },
        isToolConcurrencySafe: () => false,
        executeTool: async () => ({
          modelContent: "model result",
          displayContent: "display result",
          outcome: "ok",
          persisted,
          uiData,
        }),
      });

      expect(result).toMatchObject({ status: "completed" });
      expect(toolMessages(history)).toEqual([
        { role: "tool", content: "model result", tool_call_id: "call-1" },
      ]);
      expect(events).toEqual([
        {
          type: "tool_call_start",
          turnId: "turn-1",
          toolCallId: "call-1",
          name: "edit",
          args: "{\"name\":\"edit\"}",
        },
        {
          type: "tool_call_end",
          turnId: "turn-1",
          toolCallId: "call-1",
          result: "display result",
          outcome: "ok",
          persisted,
          uiData,
        },
      ]);
    });
  });

  test("并发工具可以逆序完成但按模型顺序提交", async () => {
    await withTempProject(async (cwd) => {
      const calls = [call("safe-1"), call("safe-2"), call("safe-3")];
      const releases = new Map(calls.map((item) => [item.id, deferred()]));
      const allStarted = deferred();
      const completions: string[] = [];
      const events: AgentEvent[] = [];
      const history: Message[] = [];
      let started = 0;

      const running = executeToolCallBatch({
        toolCalls: calls,
        history,
        ctx: createTestContext(cwd),
        turnId: "turn-concurrent",
        onEvent: (event) => {
          events.push(event);
        },
        isToolConcurrencySafe: () => true,
        executeTool: async (name) => {
          started += 1;
          if (started === calls.length) allStarted.resolve();
          await releases.get(name)!.promise;
          completions.push(name);
          return `${name} result`;
        },
      });

      await allStarted.promise;
      releases.get("safe-3")!.resolve();
      await Promise.resolve();
      releases.get("safe-2")!.resolve();
      await Promise.resolve();
      releases.get("safe-1")!.resolve();
      await running;

      expect(completions).toEqual(["safe-3", "safe-2", "safe-1"]);
      expect(toolMessages(history).map((message) => message.tool_call_id)).toEqual([
        "safe-1",
        "safe-2",
        "safe-3",
      ]);
      expect(
        events
          .filter((event) => event.type === "tool_call_end")
          .map((event) => event.toolCallId)
      ).toEqual(["safe-1", "safe-2", "safe-3"]);
    });
  });

  test("非安全工具在前后安全组之间独占执行", async () => {
    await withTempProject(async (cwd) => {
      const calls = [call("safe-1"), call("safe-2"), call("write"), call("safe-3")];
      const active = new Set<string>();
      let overlap = false;
      const starts: string[] = [];

      await executeToolCallBatch({
        toolCalls: calls,
        history: [],
        ctx: createTestContext(cwd),
        turnId: "turn-groups",
        onEvent: () => {},
        isToolConcurrencySafe: (name) => name.startsWith("safe-"),
        executeTool: async (name) => {
          if (name === "write" ? active.size > 0 : active.has("write")) overlap = true;
          active.add(name);
          starts.push(name);
          await new Promise((resolve) => setTimeout(resolve, 3));
          active.delete(name);
          return name;
        },
      });

      expect(overlap).toBe(false);
      expect(starts.indexOf("write")).toBeGreaterThan(starts.indexOf("safe-2"));
      expect(starts.indexOf("safe-3")).toBeGreaterThan(starts.indexOf("write"));
    });
  });

  test("执行前取消时不运行工具并补齐全部 interrupted result", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      controller.abort("user-cancel");
      const history: Message[] = [];
      const events: AgentEvent[] = [];
      let executions = 0;

      const result = await executeToolCallBatch({
        toolCalls: [call("one"), call("two")],
        history,
        ctx: createTestContext(cwd, { signal: controller.signal }),
        turnId: "turn-cancelled",
        onEvent: (event) => {
          events.push(event);
        },
        isToolConcurrencySafe: () => false,
        executeTool: async () => {
          executions += 1;
          return "not reached";
        },
      });

      expect(result).toMatchObject({ status: "interrupted" });
      expect(executions).toBe(0);
      expect(toolMessages(history).map((message) => message.tool_call_id)).toEqual([
        "one",
        "two",
      ]);
      expect(toolMessages(history).every((message) => contentText(message.content).includes("user-cancel")))
        .toBe(true);
      expect(events.filter((event) => event.type === "tool_call_start")).toHaveLength(2);
      expect(events.filter((event) => event.type === "tool_call_end")).toHaveLength(2);
      expect(events.some((event) => event.type === "turn_interrupted")).toBe(false);
    });
  });

  test("串行工具执行中取消后不运行 tail 并补齐结果", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const started = deferred();
      const history: Message[] = [];
      const executed: string[] = [];
      const running = executeToolCallBatch({
        toolCalls: [call("slow"), call("tail")],
        history,
        ctx: createTestContext(cwd, { signal: controller.signal }),
        turnId: "turn-serial-cancel",
        onEvent: () => {},
        isToolConcurrencySafe: () => false,
        executeTool: async (name, _args, ctx) => {
          executed.push(name);
          started.resolve();
          await abortableDelay(10_000, ctx.signal);
          return "not reached";
        },
      });

      await started.promise;
      controller.abort("user-cancel");
      expect(await running).toMatchObject({ status: "interrupted" });
      expect(executed).toEqual(["slow"]);
      expect(toolMessages(history).map((message) => message.tool_call_id)).toEqual([
        "slow",
        "tail",
      ]);
    });
  });

  test("并发工具取消后补齐整组且不启动后续非安全工具", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const bothStarted = deferred();
      const history: Message[] = [];
      const executed: string[] = [];
      const running = executeToolCallBatch({
        toolCalls: [call("safe-1"), call("safe-2"), call("unsafe-tail")],
        history,
        ctx: createTestContext(cwd, { signal: controller.signal }),
        turnId: "turn-parallel-cancel",
        onEvent: () => {},
        isToolConcurrencySafe: (name) => name.startsWith("safe-"),
        executeTool: async (name, _args, ctx) => {
          executed.push(name);
          if (executed.length === 2) bothStarted.resolve();
          await abortableDelay(10_000, ctx.signal);
          return "not reached";
        },
      });

      await bothStarted.promise;
      controller.abort("user-cancel");
      expect(await running).toMatchObject({ status: "interrupted" });
      expect(executed.sort()).toEqual(["safe-1", "safe-2"]);
      expect(toolMessages(history).map((message) => message.tool_call_id)).toEqual([
        "safe-1",
        "safe-2",
        "unsafe-tail",
      ]);
      expect(toolMessages(history).every((message) => contentText(message.content).includes("已取消")))
        .toBe(true);
    });
  });

  test("普通异常补齐未提交结果并保留原始 Error", async () => {
    await withTempProject(async (cwd) => {
      const failure = new Error("executor exploded");
      const history: Message[] = [];
      const events: AgentEvent[] = [];
      let caught: unknown;
      try {
        await executeToolCallBatch({
          toolCalls: [call("broken"), call("tail")],
          history,
          ctx: createTestContext(cwd),
          turnId: "turn-failed",
          onEvent: (event) => {
            events.push(event);
          },
          isToolConcurrencySafe: () => false,
          executeTool: async () => {
            throw failure;
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(failure);
      expect(toolMessages(history).map((message) => message.tool_call_id)).toEqual([
        "broken",
        "tail",
      ]);
      expect(toolMessages(history).every((message) => contentText(message.content).includes("executor exploded")))
        .toBe(true);
      expect(events.filter((event) => event.type === "tool_call_start")).toHaveLength(2);
      expect(events.filter((event) => event.type === "tool_call_end")).toHaveLength(2);
    });
  });

  test("并发组一个 worker 异常时整组修复且不启动后续 group", async () => {
    await withTempProject(async (cwd) => {
      const failure = new Error("parallel exploded");
      const history: Message[] = [];
      const executed: string[] = [];
      let caught: unknown;
      try {
        await executeToolCallBatch({
          toolCalls: [call("safe-fail"), call("safe-ok"), call("unsafe-tail")],
          history,
          ctx: createTestContext(cwd),
          turnId: "turn-parallel-failed",
          onEvent: () => {},
          isToolConcurrencySafe: (name) => name.startsWith("safe-"),
          executeTool: async (name) => {
            executed.push(name);
            if (name === "safe-fail") throw failure;
            return "completed but not committed";
          },
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(failure);
      expect(executed.sort()).toEqual(["safe-fail", "safe-ok"]);
      expect(toolMessages(history).map((message) => message.tool_call_id)).toEqual([
        "safe-fail",
        "safe-ok",
        "unsafe-tail",
      ]);
      expect(toolMessages(history).every((message) => contentText(message.content).includes("parallel exploded")))
        .toBe(true);
    });
  });

  test("修复路径跳过已有 tool message，避免重复配对", async () => {
    await withTempProject(async (cwd) => {
      const history: Message[] = [
        { role: "tool", content: "already paired", tool_call_id: "broken" },
      ];

      await expect(executeToolCallBatch({
        toolCalls: [call("broken"), call("tail")],
        history,
        ctx: createTestContext(cwd),
        turnId: "turn-existing",
        onEvent: () => {},
        isToolConcurrencySafe: () => false,
        executeTool: async () => {
          throw new Error("failed after prior pair");
        },
      })).rejects.toThrow("failed after prior pair");

      expect(toolMessages(history).filter((message) => message.tool_call_id === "broken"))
        .toHaveLength(1);
      expect(toolMessages(history).filter((message) => message.tool_call_id === "tail"))
        .toHaveLength(1);
    });
  });

  test("聚合预算跨 execution groups 生效且不改写 display event", async () => {
    await withTempProject(async (cwd) => {
      const history: Message[] = [];
      const events: AgentEvent[] = [];
      const result = await executeToolCallBatch({
        toolCalls: [call("safe-large"), call("write-large")],
        history,
        ctx: createTestContext(cwd),
        turnId: "turn-budget",
        onEvent: (event) => {
          events.push(event);
        },
        isToolConcurrencySafe: (name) => name.startsWith("safe-"),
        executeTool: async (name) => ({
          modelContent: name.startsWith("safe-")
            ? "a".repeat(120_000)
            : "b".repeat(120_000),
          displayContent: `${name} display`,
          outcome: "ok",
        }),
      });

      expect(result).toMatchObject({ status: "completed" });
      expect(
        toolMessages(history).filter((message) =>
          contentText(message.content).includes("<persisted-output>")
        )
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "tool_result_persisted")
      ).toHaveLength(1);
      expect(
        events
          .filter((event) => event.type === "tool_call_end")
          .map((event) => event.result)
      ).toEqual(["safe-large display", "write-large display"]);
    });
  });
});
