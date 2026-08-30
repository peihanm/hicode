import { describe, expect, test } from "bun:test";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { executeTool, executeToolResult } from "../helpers/executeTool.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTurnAbortController } from "../../src/runtime/abort.js";
import { runShellCommand } from "../../src/tools/bash/process.js";
import { createTestToolResultStore } from "../helpers/toolResultStore.js";
import { join } from "node:path";
import { createTaskRuntimeForTest } from "../helpers/taskRuntime.js";
import { createDisabledSandboxRuntime } from "../../src/sandbox/index.js";
import { createShellRunner } from "../../src/tools/bash/shellRunner.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

function createTaskSession(cwd: string) {
  const runtime = createTaskRuntimeForTest(
    cwd,
    createShellRunner(createDisabledSandboxRuntime(), testChildEnvironment),
    () => async () => {
      throw new Error("Bash contract 不启动 Agent Task");
    }
  );
  const store = createTestToolResultStore(cwd, "bash-task-session", {
    pillarHome: join(cwd, ".pillar-test-results"),
  });
  return {
    runtime,
    tasks: runtime.forSession({sessionId: store.sessionId, toolResultStore: store}),
  };
}

describe("bash tool contract", () => {
  test("require_escalated 即使在 bypassPermissions 下也单独询问", async () => {
    await withTempProject(async (cwd) => {
      const requests: Array<{ tool: string; message: string }> = [];
      const result = await executeToolResult(
        "bash",
        JSON.stringify({
          command: "printf elevated",
          sandbox_permissions: "require_escalated",
        }),
        createTestContext(cwd, {
          permissionMode: "bypassPermissions",
          canUseTool: async (tool, message) => {
            requests.push({ tool, message });
            return { behavior: "allow" };
          },
        }),
        "elevated-bash"
      );
      expect(result.outcome).toBe("ok");
      expect(result.modelContent).toBe("elevated");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ tool: "bash" });
      expect(requests[0]?.message).toContain("脱离 OS Sandbox");
    });
  });

  test("dontAsk 拒绝 require_escalated 且不执行命令", async () => {
    await withTempProject(async (cwd) => {
      const result = await executeToolResult(
        "bash",
        JSON.stringify({
          command: "printf forbidden",
          sandbox_permissions: "require_escalated",
        }),
        createTestContext(cwd, {
          permissionMode: "dontAsk",
          canUseTool: async () => {
            throw new Error("不应进入交互确认");
          },
        }),
        "denied-elevated-bash"
      );
      expect(result.outcome).toBe("denied");
      expect(result.modelContent).toContain("dontAsk");
    });
  });

  test("命令默认在 ToolContext.cwd，显式 cwd 可以选择项目子目录", async () => {
    await withTempProject(async (cwd) => {
      const defaultResult = await executeTool(
        "bash",
        JSON.stringify({ command: "pwd" }),
        createTestContext(cwd)
      );
      expect(await realpath(defaultResult.trim())).toBe(await realpath(cwd));

      const nested = join(cwd, "nested");
      await mkdir(nested);
      const nestedResult = await executeTool(
        "bash",
        JSON.stringify({ command: "pwd", cwd: "nested" }),
        createTestContext(cwd)
      );
      expect(await realpath(nestedResult.trim())).toBe(await realpath(nested));
    });
  });

  test("cwd 不能越过当前项目目录", async () => {
    await withTempProject(async (cwd) => {
      const result = await executeToolResult(
        "bash",
        JSON.stringify({ command: "pwd", cwd: ".." }),
        createTestContext(cwd, {permissionMode: "bypassPermissions"}),
        "outside-cwd"
      );
      expect(result.outcome).toBe("denied");
      expect(result.modelContent).toContain("Bash cwd 必须位于当前项目目录内");
    });
  });

  test("拒绝 shell 后台操作符并引导使用受管任务", async () => {
    await withTempProject(async (cwd) => {
      const result = await executeToolResult(
        "bash",
        JSON.stringify({
          command: "node server.js &",
          run_in_background: true,
        }),
        createTestContext(cwd, {permissionMode: "bypassPermissions"}),
        "unmanaged-background"
      );
      expect(result.outcome).toBe("denied");
      expect(result.modelContent).toContain("禁止使用 shell 后台操作符 &");
      expect(result.modelContent).toContain("run_in_background=true");
      expect(result.modelContent).toContain("bash_task stop");
    });
  });

  test("非零退出码保留 stdout、stderr 和状态", async () => {
    await withTempProject(async (cwd) => {
      const result = await executeTool(
        "bash",
        JSON.stringify({
          command: "printf stdout; printf stderr >&2; exit 7",
        }),
        createTestContext(cwd)
      );
      expect(result).toContain("执行失败 (exit code 7)");
      expect(result).toContain("stdout");
      expect(result).toContain("stderr");
    });
  });

  test("前台 timeout 明确说明进程树已终止", async () => {
    await withTempProject(async (cwd) => {
      const result = await executeToolResult(
        "bash",
        JSON.stringify({
          command: "node -e \"setTimeout(() => {}, 5000)\"",
          timeout_ms: 100,
        }),
        createTestContext(cwd),
        "timeout-bash"
      );
      expect(result.outcome).toBe("failed");
      expect(result.modelContent).toContain("timeout 100ms");
      expect(result.modelContent).toContain("命令及其子进程已经终止");
      expect(result.modelContent).toContain("run_in_background=true");
    });
  });

  test("后台 Bash 返回 task ID，bash_task 可读取完成输出", async () => {
    await withTempProject(async (cwd) => {
      const {runtime, tasks} = createTaskSession(cwd);
      try {
        const ctx = createTestContext(cwd, { tasks });
        const started = await executeToolResult(
          "bash",
          JSON.stringify({
            command: "node -e \"process.stdout.write('x'.repeat(30000)); setTimeout(() => console.log('done'), 50)\"",
            run_in_background: true,
          }),
          ctx,
          "background-bash"
        );
        expect(started.outcome).toBe("ok");
        const taskId = started.modelContent.match(/Task: ([0-9a-f-]+)/)?.[1];
        expect(taskId).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 150));
        const status = await executeToolResult(
          "bash_task",
          JSON.stringify({ task_id: taskId, action: "status" }),
          ctx,
          "background-status"
        );
        expect(status.outcome).toBe("ok");
        expect(status.modelContent).toContain("Status: completed");
        expect(status.modelContent).toContain("字节已省略");
        expect(status.modelContent.length).toBeLessThan(22_000);
        expect(status.modelContent).toContain("done");
      } finally {
        await runtime.close();
      }
    });
  });

  test("bash_task 可以停止仍在运行的后台进程", async () => {
    await withTempProject(async (cwd) => {
      const {runtime, tasks} = createTaskSession(cwd);
      try {
        const ctx = createTestContext(cwd, { tasks });
        const started = await executeTool(
          "bash",
          JSON.stringify({
            command: "node -e \"setInterval(() => console.log('tick'), 20)\"",
            run_in_background: true,
          }),
          ctx
        );
        const taskId = started.match(/Task: ([0-9a-f-]+)/)?.[1];
        expect(taskId).toBeDefined();

        const stopped = await executeToolResult(
          "bash_task",
          JSON.stringify({ task_id: taskId, action: "stop" }),
          ctx,
          "background-stop"
        );
        expect(stopped.outcome).toBe("ok");
        expect(stopped.modelContent).toContain("Status: cancelled");
        expect(stopped.modelContent).toContain("aborted user-cancel");
        expect(await tasks.claimNotifications()).toEqual([]);
      } finally {
        await runtime.close();
      }
    });
  });

  test("相同目录中的相同后台命令必须先查询或停止", async () => {
    await withTempProject(async (cwd) => {
      const {runtime, tasks} = createTaskSession(cwd);
      try {
        const ctx = createTestContext(cwd, { tasks });
        const input = JSON.stringify({
          command: "node -e \"setInterval(() => {}, 1000)\"",
          run_in_background: true,
        });
        const started = await executeToolResult(
          "bash",
          input,
          ctx,
          "first-background"
        );
        const taskId = started.modelContent.match(/Task: ([0-9a-f-]+)/)?.[1];
        expect(taskId).toBeDefined();

        const duplicate = await executeToolResult(
          "bash",
          input,
          ctx,
          "duplicate-background"
        );
        expect(duplicate.outcome).toBe("failed");
        expect(duplicate.modelContent).toContain(`Task: ${taskId}`);
        expect(duplicate.modelContent).toContain("bash_task stop");

        await tasks.stop(taskId!);
      } finally {
        await runtime.close();
      }
    });
  });

  test("超长输出落盘且进入模型的内容保持有界", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd);
      const result = await executeToolResult(
        "bash",
        JSON.stringify({
          command: "node -e \"process.stdout.write('x'.repeat(40000))\"",
        }),
        ctx,
        "large-bash"
      );
      expect(result.modelContent).toContain("<persisted-output>");
      expect(result.modelContent.length).toBeLessThan(5_000);
      expect(result.persisted?.complete).toBe(true);
      const chunk = await ctx.toolResultStore.readRange({
        resultId: result.persisted!.resultId,
        offset: 0,
        limit: 4096,
      });
      expect(chunk.content).toBe("x".repeat(4096));
      expect(chunk.byteLength).toBe(40_000);
    });
  });

  test("超过旧 1MB buffer 的输出不会提前终止命令", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd);
      const result = await executeToolResult(
        "bash",
        JSON.stringify({
          command: "node -e \"process.stdout.write('y'.repeat(1100000))\"",
        }),
        ctx,
        "megabyte-bash"
      );
      expect(result.outcome).toBe("ok");
      expect(result.persisted?.byteLength).toBe(1_100_000);
      expect(result.persisted?.complete).toBe(true);
    });
  });

  test("命中 artifact cap 时保留 partial 结果并返回失败状态", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "capped-session", {
        pillarHome: join(cwd, "store"),
        maxArtifactBytes: 1024,
      });
      const ctx = createTestContext(cwd, {
        sessionId: "capped-session",
        toolResultStore: store,
      });
      const result = await executeToolResult(
        "bash",
        JSON.stringify({
          command: "node -e \"process.stdout.write('c'.repeat(5000))\"",
        }),
        ctx,
        "capped-bash"
      );
      expect(result.outcome).toBe("failed");
      expect(result.persisted).toMatchObject({
        byteLength: 1024,
        complete: false,
      });
      expect(result.modelContent).toContain("Complete: no");
    });
  });

  test("取消长命令会终止整个 POSIX process group", async () => {
    if (process.platform === "win32") return;
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const startedAt = Date.now();
      const running = runShellCommand({
        command: "sleep 30 & echo $!; wait",
        cwd,
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      controller.abort("user-cancel");
      const result = await running;
      const childPid = Number(result.stdout.trim().split(/\s+/)[0]);

      expect(result.termination).toMatchObject({
        kind: "aborted",
        reason: "user-cancel",
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(Number.isInteger(childPid)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(() => process.kill(childPid, 0)).toThrow();
    });
  });

  test("通过 Tool Runner 取消 Bash 后不会遗留 capture 临时文件", async () => {
    await withTempProject(async (cwd) => {
      const controller = createTurnAbortController();
      const ctx = createTestContext(cwd, { signal: controller.signal });
      const running = executeToolResult(
        "bash",
        JSON.stringify({ command: "printf started; sleep 30" }),
        ctx,
        "cancelled-bash"
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      controller.abort("user-cancel");
      const result = await running;
      expect(result.outcome).toBe("interrupted");
      expect((await readdir(ctx.toolResultStore.sessionDir)).some(
        (name) => name.startsWith(".tmp-")
      )).toBe(false);
    });
  });
});
