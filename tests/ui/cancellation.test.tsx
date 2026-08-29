import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import type { AgentRunner } from "../../src/agent/index.js";
import {
  abortableDelay,
  normalizeTurnAbortReason,
} from "../../src/runtime/abort.js";
import { AppForTest as App } from "../helpers/AppForTest.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTestRuntimeResources } from "../helpers/runtimeResources.js";

afterEach(() => cleanup());

describe("App cancellation", () => {
  test("Agent 运行期间 Shift+Tab 会切换后续工具使用的权限模式", async () => {
    await withTempProject(async (cwd) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });
      let observedMode: string | undefined;
      const runAgentImpl: AgentRunner = async (
        _input,
        _history,
        _onEvent,
        ctx
      ) => {
        started();
        await released;
        observedMode = ctx.permissionMode;
        return {
          reply: "done",
          reason: "completed",
          iterations: 1,
        };
      };
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );

      instance.stdin.write("运行时切换模式");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await didStart;
      await new Promise((resolve) => setTimeout(resolve, 20));

      instance.stdin.write("\u001B[Z");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instance.lastFrame()).toContain("Accept");

      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(observedMode).toBe("acceptEdits");
    });
  });

  test("模型等待期间只产生有界的局部 spinner 动画帧", async () => {
    await withTempProject(async (cwd) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });
      const runAgentImpl: AgentRunner = async () => {
        started();
        await released;
        return { reply: "done", reason: "completed", iterations: 1 };
      };
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );
      instance.stdin.write("等待模型");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await didStart;
      await new Promise((resolve) => setTimeout(resolve, 30));
      const settledFrameCount = instance.frames.length;

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(instance.frames.length).toBeGreaterThan(settledFrameCount);
      expect(instance.frames.length).toBeLessThanOrEqual(
        settledFrameCount + 12
      );
      expect(instance.lastFrame()).toContain("思考中");

      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  });

  test("Esc 取消运行中的 turn，完成清理后恢复输入", async () => {
    await withTempProject(async (cwd) => {
      let observedSignal: AbortSignal | undefined;
      let started!: () => void;
      const didStart = new Promise<void>((resolve) => {
        started = resolve;
      });

      const runAgentImpl: AgentRunner = async (
        _input,
        _history,
        onEvent,
        ctx
      ) => {
        observedSignal = ctx.signal;
        started();
        try {
          await abortableDelay(10_000, ctx.signal);
          throw new Error("不应到达");
        } catch {
          const reason = normalizeTurnAbortReason(ctx.signal.reason);
          onEvent({ type: "turn_interrupted", reason });
          return {
            reply: "(任务已取消)",
            reason: "interrupted",
            iterations: 1,
            abortReason: reason,
          };
        }
      };

      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );
      instance.stdin.write("执行长任务");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await didStart;
      expect(instance.lastFrame()).toContain("思考中");
      await new Promise((resolve) => setTimeout(resolve, 30));

      instance.stdin.write("\u001B");
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(observedSignal?.aborted).toBe(true);
      expect(instance.lastFrame()).toContain("任务已取消（user-cancel）");
      expect(instance.lastFrame()).toContain("❯");
      expect(instance.lastFrame()).not.toContain("正在停止");
    });
  });

  test("流式 Function Calling 在等待完成时显示工具名和输出 token", async () => {
    await withTempProject(async (cwd) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let progressRendered!: () => void;
      const didRenderProgress = new Promise<void>((resolve) => {
        progressRendered = resolve;
      });
      const runAgentImpl: AgentRunner = async (
        _input,
        _history,
        onEvent
      ) => {
        onEvent({ type: "model_stream_start" });
        onEvent({
          type: "model_stream_progress",
          phase: "tool_input",
          outputCharacters: 4936,
          estimatedOutputTokens: 1234,
          toolName: "write_file",
        });
        progressRendered();
        await released;
        onEvent({ type: "model_stream_end" });
        return { reply: "done", reason: "completed", iterations: 1 };
      };

      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );
      instance.stdin.write("创建长文件");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await didRenderProgress;
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(instance.lastFrame()).toContain("正在构造 write_file 参数");
      expect(instance.lastFrame()).toContain("tokens");
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });

  test("长时间无流数据时使用 Provider 无关的诚实提示", async () => {
    await withTempProject(async (cwd) => {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let statusReady!: () => void;
      const didSetStatus = new Promise<void>((resolve) => {
        statusReady = resolve;
      });
      const runAgentImpl: AgentRunner = async (
        _input,
        _history,
        onEvent
      ) => {
        onEvent({ type: "model_stream_start" });
        onEvent({
          type: "model_stream_progress",
          phase: "stalled",
          outputCharacters: 0,
          estimatedOutputTokens: 0,
          idleMilliseconds: 60_000,
        });
        statusReady();
        await released;
        onEvent({ type: "model_stream_end" });
        return { reply: "done", reason: "completed", iterations: 1 };
      };
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );
      instance.stdin.write("创建大型文件");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await didSetStatus;
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(instance.lastFrame()).toContain(
        "模型暂无流数据，可能仍在服务端处理"
      );
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });
});
