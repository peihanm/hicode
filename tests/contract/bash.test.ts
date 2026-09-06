import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { executeTool, executeToolResult } from "../helpers/executeTool.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTurnAbortController } from "../../src/runtime/abort.js";
import { runShellCommand } from "../../src/tools/bash/process.js";
import { createTestToolResultStore } from "../helpers/toolResultStore.js";
import { join } from "node:path";
import { createTaskRuntimeForTest } from "../helpers/taskRuntime.js";
import { createDisabledSandboxRuntime } from "../../src/sandbox/index.js";
import {
  createShellRunner,
  type ShellRunnerLike,
} from "../../src/tools/bash/shellRunner.js";
import type {ToolContext} from "../../src/tools/types.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const readySandboxRunner: ShellRunnerLike = {
  sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
  run: runShellCommand,
};

function networkCaptureRunner(): {
  runner: ShellRunnerLike;
  calls: Array<{
    command: string;
    sandboxPermissions?: "use_default" | "require_escalated";
  }>;
} {
  const calls: Array<{
    command: string;
    sandboxPermissions?: "use_default" | "require_escalated";
  }> = [];
  return {
    calls,
    runner: {
      sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
      async run(request) {
        calls.push({
          command: request.command,
          sandboxPermissions: request.sandboxPermissions,
        });
        return {
          stdout: "install completed",
          stderr: "",
          termination: {kind: "exit", code: 0, signal: null},
        };
      },
    },
  };
}

function createTaskSession(
  cwd: string,
  shellRunner: ShellRunnerLike = createShellRunner(
    createDisabledSandboxRuntime(),
    testChildEnvironment
  )
) {
  const runtime = createTaskRuntimeForTest(
    cwd,
    shellRunner,
    () => ({
      agentId: "unused",
      async run() {
        throw new Error("Bash contract 不启动 Agent Task");
      },
    })
  );
  const store = createTestToolResultStore(cwd, "test-session", {
    pillarHome: join(cwd, ".pillar-test-results"),
  });
  return {
    runtime,
    tasks: runtime.forSession({sessionId: store.sessionId, toolResultStore: store}),
  };
}

describe("bash tool contract", () => {
  test("default 自动执行 ready Sandbox 内的普通 Bash", async () => {
    await withTempProject(async (cwd) => {
      const result = await executeToolResult(
        "bash",
        JSON.stringify({command: "printf sandboxed-default"}),
        createTestContext(cwd, {
          permissionMode: "default",
        collaborationMode: "build",
          shellRunner: readySandboxRunner,
          canUseTool: async () => {
            throw new Error("ready Sandbox 内的普通 Bash 不应请求权限");
          },
        }),
        "sandboxed-default-bash"
      );

      expect(result.outcome).toBe("ok");
      expect(result.modelContent).toBe("sandboxed-default");
    });
  });

  test("default 在 Sandbox disabled 时仍询问普通 Bash", async () => {
    await withTempProject(async (cwd) => {
      const requests: string[] = [];
      const result = await executeToolResult(
        "bash",
        JSON.stringify({command: "printf host-default"}),
        createTestContext(cwd, {
          permissionMode: "default",
        collaborationMode: "build",
          canUseTool: async (tool) => {
            requests.push(tool);
            return {behavior: "allow"};
          },
        }),
        "host-default-bash"
      );

      expect(result.outcome).toBe("ok");
      expect(result.modelContent).toBe("host-default");
      expect(requests).toEqual(["bash"]);
    });
  });

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
        collaborationMode: "build",
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

  test("依赖安装不再根据命令字符串推测网络需求或自动提权", async () => {
    await withTempProject(async (cwd) => {
      const {runner, calls} = networkCaptureRunner();
      const requests: Array<{
        message: string;
        options?: Parameters<ToolContext["canUseTool"]>[3];
      }> = [];
      const result = await executeToolResult(
        "bash",
        JSON.stringify({command: "npm install && npm run build"}),
        createTestContext(cwd, {
          permissionMode: "bypassPermissions",
          collaborationMode: "build",
          shellRunner: runner,
          canUseTool: async (_tool, message, _input, options) => {
            requests.push({message, options});
            return {behavior: "allow"};
          },
        }),
        "network-package-install"
      );

      expect(result.outcome).toBe("ok");
      expect(requests).toHaveLength(0);
      expect(calls).toEqual([{
        command: "npm install && npm run build",
        sandboxPermissions: undefined,
      }]);
    });
  });

  test("直接启动 macOS 应用时先申请单次宿主执行权限", async () => {
    await withTempProject(async (cwd) => {
      const {runner, calls} = networkCaptureRunner();
      const command =
        '"/Applications/Test Browser.app/Contents/MacOS/Test Browser" --headless=new';
      const requests: Array<{
        message: string;
        options?: Parameters<ToolContext["canUseTool"]>[3];
      }> = [];
      const result = await executeToolResult(
        "bash",
        JSON.stringify({command}),
        createTestContext(cwd, {
          permissionMode: "bypassPermissions",
          collaborationMode: "build",
          shellRunner: runner,
          canUseTool: async (_tool, message, _input, options) => {
            requests.push({message, options});
            return {behavior: "allow"};
          },
        }),
        "macos-app-host-execution"
      );

      expect(result.outcome).toBe("ok");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.message).toContain("启动 macOS 应用进程");
      expect(requests[0]?.options).toEqual({
        allowPersistent: false,
        presentation: {
          kind: "host_execution",
          reason: "启动 macOS 应用进程",
          command,
        },
      });
      expect(calls).toEqual([{command, sandboxPermissions: "require_escalated"}]);
    });
  });

  test("参数中出现 macOS 应用路径不会误触发宿主执行授权", async () => {
    await withTempProject(async (cwd) => {
      const {runner, calls} = networkCaptureRunner();
      const command =
        'printf "%s" "/Applications/Test.app/Contents/MacOS/Test"';
      const result = await executeToolResult(
        "bash",
        JSON.stringify({command}),
        createTestContext(cwd, {
          permissionMode: "default",
          collaborationMode: "build",
          shellRunner: runner,
          canUseTool: async () => {
            throw new Error("普通参数不应触发宿主执行授权");
          },
        }),
        "macos-app-path-argument"
      );

      expect(result.outcome).toBe("ok");
      expect(calls).toEqual([{command, sandboxPermissions: undefined}]);
    });
  });

  test("npx 本地调用不提前询问", async () => {
    await withTempProject(async (cwd) => {
      const {runner, calls} = networkCaptureRunner();
      const result = await executeToolResult(
        "bash",
        JSON.stringify({command: "npx --version"}),
        createTestContext(cwd, {
          permissionMode: "default",
          collaborationMode: "build",
          shellRunner: runner,
          canUseTool: async () => {
            throw new Error("已允许的 Registry 不应再次询问");
          },
        }),
        "allowed-package-install"
      );

      expect(result.outcome).toBe("ok");
      expect(calls).toEqual([{
        command: "npx --version",
        sandboxPermissions: undefined,
      }]);
    });
  });

  test("非交互 Host 也可以执行没有实际联网的缓存安装", async () => {
    await withTempProject(async (cwd) => {
      const {runner, calls} = networkCaptureRunner();
      const result = await executeToolResult(
        "bash",
        JSON.stringify({command: "npm install"}),
        createTestContext(cwd, {
          permissionMode: "default",
          collaborationMode: "build",
          permissionPromptPolicy: "never",
          shellRunner: runner,
          canUseTool: async () => {
            throw new Error("非交互 Host 不应进入权限 callback");
          },
        }),
        "denied-package-install"
      );

      expect(result.outcome).toBe("ok");
      expect(calls).toEqual([{command: "npm install", sandboxPermissions: undefined}]);
    });
  });

  test("非交互 Host 拒绝 require_escalated 且不执行命令", async () => {
    await withTempProject(async (cwd) => {
      const result = await executeToolResult(
        "bash",
        JSON.stringify({
          command: "printf forbidden",
          sandbox_permissions: "require_escalated",
        }),
        createTestContext(cwd, {
          permissionMode: "readOnly",
        collaborationMode: "build",
          permissionPromptPolicy: "never",
          canUseTool: async () => {
            throw new Error("不应进入交互确认");
          },
        }),
        "denied-elevated-bash"
      );
      expect(result.outcome).toBe("denied");
      expect(result.modelContent).toContain("当前 Host 不支持权限交互");
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
        expect(started.modelContent).toContain("启动观察期内已完成");
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

  test("后台 Bash 在启动观察期内失败时直接返回失败且不重复通知", async () => {
    await withTempProject(async (cwd) => {
      const sandboxDeniedRunner: ShellRunnerLike = {
        sandboxStatus: {kind: "ready", platform: "macos", warnings: []},
        async run(request) {
          const output = "Error: listen EPERM: operation not permitted 127.0.0.1:8000\n";
          await appendFile(request.outputFilePath!, output);
          return {
            stdout: "",
            stderr: "",
            termination: {kind: "exit", code: 1, signal: null},
            outputFilePath: request.outputFilePath,
            outputBytes: Buffer.byteLength(output),
            outputComplete: true,
          };
        },
      };
      const {runtime, tasks} = createTaskSession(cwd, sandboxDeniedRunner);
      try {
        const result = await executeToolResult(
          "bash",
          JSON.stringify({
            command: "node server.js",
            run_in_background: true,
          }),
          createTestContext(cwd, {tasks}),
          "background-startup-failure"
        );

        expect(result.outcome).toBe("failed");
        expect(result.modelContent).toContain("启动观察期内已失败");
        expect(result.modelContent).toContain("Status: failed");
        expect(result.modelContent).toContain("Termination: exit 1");
        expect(result.modelContent).toContain("listen EPERM");
        expect(result.modelContent).toContain("Pillar Sandbox: 本地端口监听被");
        expect(result.modelContent).toContain("不要换端口或重写服务");
        expect(await tasks.pendingNotifications()).toEqual([]);
      } finally {
        await runtime.close();
      }
    });
  });

  test("后台 Bash 安全忽略前台 timeout，不会终止已启动的服务", async () => {
    await withTempProject(async (cwd) => {
      const {runtime, tasks} = createTaskSession(cwd);
      try {
        const ctx = createTestContext(cwd, { tasks });
        const started = await executeToolResult(
          "bash",
          JSON.stringify({
            command: "node -e \"setInterval(() => {}, 1000)\"",
            timeout_ms: 100,
            run_in_background: true,
          }),
          ctx,
          "background-ignores-foreground-timeout"
        );
        expect(started.outcome).toBe("ok");
        expect(started.modelContent).toContain("已忽略 timeout_ms");
        expect(started.modelContent.split("\n").slice(0, 3).join("\n")).toContain("退出 Pillar 后会终止");
        expect(started.displayContent).toContain("退出 Pillar 后会终止");
        const taskId = started.modelContent.match(/Task: ([0-9a-f-]+)/)?.[1];
        expect(taskId).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 180));
        expect(await tasks.get(taskId!)).toMatchObject({status: "running"});
        await tasks.stop(taskId!);
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
        expect(await tasks.pendingNotifications()).toEqual([]);
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
      expect(result.shellExecution).toEqual({command: "node -e \"process.stdout.write('x'.repeat(40000))\"", cwd: await realpath(cwd), sandboxPermissions: "use_default"});
      expect(result.persisted?.complete).toBe(true);
      const saved = await readFile(result.persisted!.path, "utf8");
      expect(saved).toBe("x".repeat(40_000));

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
