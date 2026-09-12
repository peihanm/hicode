import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { z } from "zod";
import type { AgentRunner } from "../../src/agent/index.js";
import { resolvePermission } from "../../src/permissions/resolvePermission.js";
import type { PermissionDecision } from "../../src/permissions/types.js";
import type { Tool } from "../../src/tools/types.js";
import { AppForTest as App } from "../helpers/AppForTest.js";
import { ConfirmDialog } from "../../src/ui/dialogs/ConfirmDialog.js";
import { ElevatedBashDialog } from "../../src/ui/dialogs/ElevatedBashDialog.js";
import { NetworkAccessDialog } from "../../src/ui/dialogs/NetworkAccessDialog.js";
import { FileAccessDialog } from "../../src/ui/dialogs/FileAccessDialog.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTestRuntimeResources } from "../helpers/runtimeResources.js";

afterEach(() => cleanup());

const ENTER = "\r";

async function flush(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("permission confirmation UI", () => {
  test("/plan 和 /build 只切换工作方式，不启动模型或改变审批策略", async () => {
    await withTempProject(async cwd => {
      const instance = render(<App resources={createTestRuntimeResources(cwd)} initialPermissionMode="auto-review"/>);
      await flush();
      instance.stdin.write("/plan");
      await flush();
      instance.stdin.write(ENTER);
      await flush(60);
      expect(instance.lastFrame()).toContain("Approve for me | Plan");
      instance.stdin.write("/build");
      await flush();
      instance.stdin.write(ENTER);
      await flush(60);
      expect(instance.lastFrame()).toContain("Approve for me");
      expect(instance.lastFrame()).not.toContain("Approve for me | Plan");
    });
  });
  test("Shift+Tab 只切换 Build/Plan，不改变权限 Profile", async () => {
    await withTempProject(async (cwd) => {
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          initialPermissionMode="auto-review"
        />
      );
      await flush(10);
      const initial = instance.lastFrame() ?? "";
      expect(initial).toContain("Approve for me");
      expect(initial).not.toContain("Approve for me | Plan");

      instance.stdin.write("\u001B[Z");
      await flush(10);
      expect(instance.lastFrame()).toContain("Approve for me | Plan");

      instance.stdin.write("\u001B[Z");
      await flush(10);
      expect(instance.lastFrame()).not.toContain("Approve for me | Plan");
      expect(instance.lastFrame()).toContain("Approve for me");
    });
  });

  test("通用权限确认使用无竖线的紧凑布局", async () => {
    const instance = render(
      <ConfirmDialog
        req={{
          id: 1,
          question: "bash requires approval",
          toolName: "bash",
          input: { command: "git status" },
          resolve: () => {},
        }}
        onDone={() => {}}
      />
    );

    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("◆ PERMISSION REQUIRED");
    expect(frame).toContain("REQUEST");
    expect(frame).toContain("ACTION");
    expect(frame).toContain("bash requires approval");
    expect(frame).toContain("❯ 1. Yes");
    expect(frame).toContain("↑↓ select · Enter confirm · Esc cancel");
    expect(frame.split("\n").some((line) => line.startsWith("│"))).toBe(false);
  });

  test("Sandbox 网络授权使用专用紧凑界面", async () => {
    const decisions: PermissionDecision[] = [];
    const onDone = mock(() => {});
    const instance = render(
      <NetworkAccessDialog
        req={{
          id: 1,
          question: "fallback text",
          toolName: "bash",
          input: {command: "npx vite"},
          allowAddToAllowList: false,
          presentation: {
            kind: "network_access",
            host: "registry.npmjs.org",
            port: 443,
          },
          resolve: (decision) => decisions.push(decision),
        }}
        onDone={onDone}
      />
    );

    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("◆ NETWORK ACCESS");
    expect(frame).toContain("Connect to");
    expect(frame).toContain("registry.npmjs.org");
    expect(frame).not.toContain("脱离 OS Sandbox");
    expect(frame).toContain("› Allow for this session");
    expect(frame).toContain("files and processes remain protected by the Sandbox");
    expect(frame).not.toContain("fallback text");
    expect(frame.split("\n").some((line) => line.startsWith("│"))).toBe(false);

    instance.stdin.write(ENTER);
    await flush();
    expect(decisions).toEqual([{behavior: "allow", networkScope: "session"}]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("App 连续网络授权使用独立弹窗状态，且单连接范围正确回传", async () => {
    await withTempProject(async (cwd) => {
      let decisions: PermissionDecision[] = [];
      let complete!: () => void;
      const done = new Promise<void>((resolve) => { complete = resolve; });
      const runAgentImpl: AgentRunner = async (_input, _history, _event, ctx) => {
        decisions = await Promise.all(["first.test", "second.test"].map((host) =>
          ctx.canUseTool("bash", "allow network", {host, port: 443}, {
            allowPersistent: false, presentation: {kind: "network_access", host, port: 443},
          })
        ));
        complete();
        return {reply: "done", reason: "completed", iterations: 1};
      };
      const instance = render(<App resources={createTestRuntimeResources(cwd)} runAgentImpl={runAgentImpl}/>);
      await flush();
      instance.stdin.write("network checks");
      await flush();
      instance.stdin.write(ENTER);
      await flush();
      expect(instance.lastFrame()).toContain("first.test:443");
      instance.stdin.write(ENTER);
      await flush();
      expect(instance.lastFrame()).toContain("second.test:443");
      instance.stdin.write("2");
      await done;
      expect(decisions).toEqual([
        {behavior: "allow", networkScope: "session"},
        {behavior: "allow", networkScope: "once"},
      ]);
    });
  });

  test("脱离 Sandbox 的本地验证显示明确用途并可展开完整命令", async () => {
    const decisions: PermissionDecision[] = [];
    const onDone = mock(() => {});
    const command = [
      "for i in {1..20}; do curl -sf http://127.0.0.1:8173/ && break; done",
      "for f in / /index.html /css/styles.css; do",
      "  curl -sf http://127.0.0.1:8173$f",
      "done",
    ].join("\n");
    const instance = render(
      <ElevatedBashDialog
        req={{
          id: 1,
          question: `该命令请求脱离 OS Sandbox：\n${command}`,
          toolName: "bash",
          input: {command, sandbox_permissions: "require_escalated"},
          allowAddToAllowList: false,
          resolve: (decision) => decisions.push(decision),
        }}
        onDone={onDone}
      />
    );

    await flush();
    const compact = instance.lastFrame() ?? "";
    expect(compact).toContain("◆ RUN OUTSIDE SANDBOX");
    expect(compact).toContain("PURPOSE");
    expect(compact).toContain("Verify local service");
    expect(compact).toContain("COMMAND");
    expect(compact).toContain("+3 more lines · e to expand");
    expect(compact).toContain("This command can access host files, network and child processes directly.");
    expect(compact).toContain("› Verify once");
    expect(compact).not.toContain("for f in / /index.html");
    expect(compact).not.toContain("Permission request");
    expect(compact.split("\n").some((line) => line.startsWith("│"))).toBe(false);

    instance.stdin.write("e");
    await flush();
    expect(instance.lastFrame()).toContain("for f in / /index.html");
    expect(instance.lastFrame()).toContain("e Collapse");

    instance.stdin.write("\u001B[B");
    await flush();
    instance.stdin.write(ENTER);
    await flush();
    expect(decisions).toEqual([{
      behavior: "deny",
      message: "User denied execution outside the Sandbox",
    }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("脱离 Sandbox 的服务启动使用独立操作文案", async () => {
    const instance = render(
      <ElevatedBashDialog
        req={{
          id: 1,
          question: "start server",
          toolName: "bash",
          input: {
            command: "node server.cjs 8000",
            sandbox_permissions: "require_escalated",
          },
          resolve: () => {},
        }}
        onDone={() => {}}
      />
    );

    await flush();
    expect(instance.lastFrame()).toContain("Start local service");
    expect(instance.lastFrame()).toContain("› Start once");
  });

  test("显式申请 macOS 应用宿主执行使用 elevated 专用界面", async () => {
    const command =
      '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new';
    const instance = render(
      <ElevatedBashDialog
        req={{
          id: 1,
          question: "launch application",
          toolName: "bash",
          input: {command, run_in_background: true, sandbox_permissions: "require_escalated"},
          allowAddToAllowList: false,
          resolve: () => {},
        }}
        onDone={() => {}}
      />
    );

    await flush();
    expect(instance.lastFrame()).toContain("◆ RUN OUTSIDE SANDBOX");
    expect(instance.lastFrame()).toContain("Launch macOS application");
    expect(instance.lastFrame()).toContain("› Launch once");
  });

  test("永久允许规则写入失败后保留确认框，用户可改为仅允许本次", async () => {
    const decisions: PermissionDecision[] = [];
    const onDone = mock(() => {});
    const persist = mock(async () => {
      throw new Error("disk unavailable");
    });
    const instance = render(
      <ConfirmDialog
        req={{
          id: 1,
          question: "bash requires approval",
          toolName: "bash",
          input: { command: "git status" },
          resolve: (decision) => decisions.push(decision),
        }}
        onDone={onDone}
        onAddToAllowList={persist}
      />
    );

    await flush();
    instance.stdin.write("2");
    await flush();

    expect(instance.lastFrame()).toContain("Failed to save project permission rules");
    expect(instance.lastFrame()).toContain("disk unavailable");
    expect(decisions).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();

    instance.stdin.write("1");
    await flush();

    expect(decisions).toEqual([{ behavior: "allow" }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("永久允许失败后可以重试，保存期间不会重复提交", async () => {
    let finishFirst!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let attempts = 0;
    const persist = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        await firstAttempt;
        throw new Error("temporary failure");
      }
    });
    const decisions: PermissionDecision[] = [];
    const onDone = mock(() => {});
    const instance = render(
      <ConfirmDialog
        req={{
          id: 1,
          question: "bash requires approval",
          toolName: "bash",
          input: { command: "git status" },
          resolve: (decision) => decisions.push(decision),
        }}
        onDone={onDone}
        onAddToAllowList={persist}
      />
    );

    await flush();
    instance.stdin.write("2");
    instance.stdin.write("2");
    await flush();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(instance.lastFrame()).toContain("Saving project permission rules");

    finishFirst();
    await flush();
    expect(instance.lastFrame()).toContain("temporary failure");
    expect(decisions).toEqual([]);

    instance.stdin.write("2");
    await flush();
    expect(persist).toHaveBeenCalledTimes(2);
    expect(decisions).toEqual([{ behavior: "allow" }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("普通工具永久允许对当前 turn 已创建的 ToolContext 立即生效", async () => {
    await withTempProject(async (cwd) => {
      const schema = z.object({ path: z.string() });
      const writeTool: Tool<typeof schema> = {
        name: "synthetic_write",
        description: "synthetic write",
        parameters: schema,
        execute: async () => "ok",
      };
      let secondDecision: Awaited<ReturnType<typeof resolvePermission>> | undefined;
      let completed!: () => void;
      const done = new Promise<void>((resolve) => {
        completed = resolve;
      });
      const runAgentImpl: AgentRunner = async (
        _input,
        _history,
        _onEvent,
        ctx
      ) => {
        await ctx.canUseTool(
          "synthetic_write",
          "synthetic_write requires approval",
          { path: "a.ts" }
        );
        secondDecision = await resolvePermission(writeTool, { path: "b.ts" }, ctx);
        completed();
        return { reply: "completed", reason: "completed", iterations: 1 };
      };

      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );
      await flush(10);
      instance.stdin.write("修改文件");
      await flush(10);
      instance.stdin.write(ENTER);
      await flush();
      expect(instance.lastFrame()).toContain("synthetic_write requires approval");

      instance.stdin.write("2");
      await done;

      expect(secondDecision).toEqual({ behavior: "allow" });
      expect(instance.lastFrame()).not.toContain("synthetic_write requires approval");
    });
  });

  test("项目外文件使用目录范围审批", async () => {
    const decisions: PermissionDecision[] = [];
    const onDone = mock(() => {});
    const instance = render(
      <FileAccessDialog
        req={{
          id: 1,
          question: "write",
          toolName: "write_file",
          input: {path: "/tmp/a.ts"},
          presentation: {
            kind: "filesystem_access",
            operation: "write",
            targetPath: "/tmp/a.ts",
            suggestedDirectory: "/tmp",
          },
          resolve: (decision) => decisions.push(decision),
        }}
        onDone={onDone}
      />
    );

    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("◆ FILE ACCESS");
    expect(frame).toContain("/tmp/a.ts");
    expect(frame).toContain("Allow /tmp for this session");
    expect(frame).toContain("Always allow /tmp for this project");

    instance.stdin.write("2");
    await flush();
    expect(decisions).toEqual([{
      behavior: "allow",
      directoryScope: "session",
    }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
