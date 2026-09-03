import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { z } from "zod";
import type { AgentRunner } from "../../src/agent/index.js";
import { resolvePermission } from "../../src/permissions/resolvePermission.js";
import type { PermissionDecision, PermissionMode } from "../../src/permissions/types.js";
import type { Tool } from "../../src/tools/types.js";
import { AppForTest as App } from "../helpers/AppForTest.js";
import { ConfirmDialog } from "../../src/ui/dialogs/ConfirmDialog.js";
import { ElevatedBashDialog } from "../../src/ui/dialogs/ElevatedBashDialog.js";
import { EnterPlanDialog } from "../../src/ui/dialogs/EnterPlanDialog.js";
import { NetworkAccessDialog } from "../../src/ui/dialogs/NetworkAccessDialog.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTestRuntimeResources } from "../helpers/runtimeResources.js";

afterEach(() => cleanup());

const ENTER = "\r";

async function flush(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("permission confirmation UI", () => {
  test("Shift+Tab 只切换 Build/Plan，不改变权限 Profile", async () => {
    await withTempProject(async (cwd) => {
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          initialPermissionMode="readOnly"
        />
      );
      await flush(10);
      const initial = instance.lastFrame() ?? "";
      expect(initial).toContain("Read Only");
      expect(initial).not.toContain("Read Only | Plan");

      instance.stdin.write("\u001B[Z");
      await flush(10);
      expect(instance.lastFrame()).toContain("Read Only | Plan");

      instance.stdin.write("\u001B[Z");
      await flush(10);
      expect(instance.lastFrame()).not.toContain("Read Only | Plan");
      expect(instance.lastFrame()).toContain("Read Only");
    });
  });

  test("enter_plan_mode 使用紧凑专用界面和整行选择", async () => {
    const decisions: PermissionDecision[] = [];
    const onDone = mock(() => {});
    const instance = render(
      <EnterPlanDialog
        req={{
          question: "不应直接展示的通用权限问题",
          toolName: "enter_plan_mode",
          input: { reason: "需要先了解项目结构，再制定实现方案。" },
          resolve: (decision) => decisions.push(decision),
        }}
        onDone={onDone}
      />
    );

    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("◆ PLAN FIRST?");
    expect(frame).toContain("WHY");
    expect(frame).toContain("需要先了解项目结构，再制定实现方案。");
    expect(frame).toContain("Start planning");
    expect(frame).toContain("Continue without a plan");
    expect(frame).not.toContain("Permission request");
    expect(frame).not.toContain("不应直接展示的通用权限问题");
    expect(frame.split("\n").some((line) => line.startsWith("│"))).toBe(false);

    instance.stdin.write("\u001B[B");
    await flush();
    instance.stdin.write(ENTER);
    await flush();

    expect(decisions).toEqual([{
      behavior: "deny",
      message: "用户拒绝进入 Plan 模式",
    }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("enter_plan_mode 按终端完整可用宽度排版并响应 resize", async () => {
    const reason = "增强电脑对手需要调整评估策略和搜索决策逻辑，先制定最小改动方案。";
    const createDialog = () => (
      <EnterPlanDialog
        req={{
          question: "plan",
          toolName: "enter_plan_mode",
          input: { reason },
          resolve: () => {},
        }}
        onDone={() => {}}
      />
    );
    const instance = render(createDialog());
    let columns = 120;
    Object.defineProperty(instance.stdout, "columns", {
      configurable: true,
      get: () => columns,
    });
    instance.rerender(createDialog());
    expect(instance.lastFrame()).toContain(reason);

    columns = 52;
    instance.stdout.emit("resize");
    await flush(90);
    expect(instance.lastFrame()).not.toContain(reason);
  });

  test("通用权限确认使用无竖线的紧凑布局", async () => {
    const instance = render(
      <ConfirmDialog
        req={{
          question: "bash 需要确认",
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
    expect(frame).toContain("bash 需要确认");
    expect(frame).toContain("❯ 1. Yes");
    expect(frame).toContain("↑↓ 选择 · Enter 确认 · Esc 取消");
    expect(frame.split("\n").some((line) => line.startsWith("│"))).toBe(false);
  });

  test("Sandbox 网络授权使用专用紧凑界面", async () => {
    const decisions: PermissionDecision[] = [];
    const onDone = mock(() => {});
    const instance = render(
      <NetworkAccessDialog
        req={{
          question: "fallback text",
          toolName: "bash",
          input: {command: "npx vite"},
          allowAddToAllowList: false,
          presentation: {
            kind: "network_access",
            reason: "npx",
            domains: ["registry.npmjs.org"],
          },
          resolve: (decision) => decisions.push(decision),
        }}
        onDone={onDone}
      />
    );

    await flush();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("◆ NETWORK ACCESS");
    expect(frame).toContain("npx 需要访问");
    expect(frame).toContain("registry.npmjs.org");
    expect(frame).toContain("RISK");
    expect(frame).toContain("› Allow once");
    expect(frame).not.toContain("fallback text");
    expect(frame.split("\n").some((line) => line.startsWith("│"))).toBe(false);

    instance.stdin.write(ENTER);
    await flush();
    expect(decisions).toEqual([{behavior: "allow"}]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("脱离 Sandbox 的 Bash 使用紧凑预览并可展开完整命令", async () => {
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
    expect(compact).toContain("COMMAND");
    expect(compact).toContain("+3 more lines · e to expand");
    expect(compact).toContain("本次命令可直接访问宿主文件、网络及子进程。");
    expect(compact).toContain("› Run once");
    expect(compact).not.toContain("for f in / /index.html");
    expect(compact).not.toContain("Permission request");
    expect(compact.split("\n").some((line) => line.startsWith("│"))).toBe(false);

    instance.stdin.write("e");
    await flush();
    expect(instance.lastFrame()).toContain("for f in / /index.html");
    expect(instance.lastFrame()).toContain("e 收起");

    instance.stdin.write("\u001B[B");
    await flush();
    instance.stdin.write(ENTER);
    await flush();
    expect(decisions).toEqual([{
      behavior: "deny",
      message: "用户拒绝脱离 Sandbox 执行命令",
    }]);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("App 将 enter_plan_mode 路由到专用界面", async () => {
    await withTempProject(async (cwd) => {
      let decision: PermissionDecision | undefined;
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
        decision = await ctx.canUseTool(
          "enter_plan_mode",
          "是否进入 Plan 模式？",
          { reason: "需要先检查项目结构。" }
        );
        completed();
        return { reply: "完成", reason: "completed", iterations: 1 };
      };
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          runAgentImpl={runAgentImpl}
        />
      );
      await flush(10);
      instance.stdin.write("开始任务");
      await flush(10);
      instance.stdin.write(ENTER);
      await flush();

      expect(instance.lastFrame()).toContain("PLAN FIRST?");
      expect(instance.lastFrame()).toContain("需要先检查项目结构。");
      expect(instance.lastFrame()).not.toContain("Permission request");
      instance.stdin.write(ENTER);
      await done;

      expect(decision).toEqual({ behavior: "allow" });
    });
  });

  test("exit_plan_mode 使用专用审批且不改变当前权限模式", async () => {
    await withTempProject(async (cwd) => {
      let modeAfterApproval: PermissionMode | undefined;
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
        await ctx.canUseTool("exit_plan_mode", "是否批准？", {
          plan: "# 实施计划\n\n1. 修改代码\n2. 运行测试",
        });
        modeAfterApproval = ctx.permissionMode;
        completed();
        return { reply: "完成", reason: "completed", iterations: 1 };
      };
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          initialPermissionMode="default"
          initialCollaborationMode="plan"
          runAgentImpl={runAgentImpl}
        />
      );
      await flush(10);
      instance.stdin.write("提交计划");
      await flush(10);
      instance.stdin.write(ENTER);
      await flush();

      expect(instance.lastFrame()).toContain("Build now");
      expect(instance.lastFrame()).not.toContain("current permissions");
      expect(instance.lastFrame()).toContain("Explore commands and workflows");
      expect(instance.lastFrame()).toContain("Keep planning");
      instance.stdin.write(ENTER);
      await done;

      expect(modeAfterApproval).toBe("default");
      expect(instance.lastFrame()).not.toContain("Build now");
    });
  });

  test("exit_plan_mode 审批中的 Esc 由专用 Dialog 拒绝，不取消整个 Turn", async () => {
    await withTempProject(async (cwd) => {
      let decision: PermissionDecision | undefined;
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
        decision = await ctx.canUseTool("exit_plan_mode", "是否批准？", {
          plan: "# 实施计划\n\n1. 修改代码",
        });
        completed();
        return { reply: "继续规划", reason: "completed", iterations: 1 };
      };
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
          initialPermissionMode="default"
          initialCollaborationMode="plan"
          runAgentImpl={runAgentImpl}
        />
      );
      await flush(10);
      instance.stdin.write("提交计划");
      await flush(10);
      instance.stdin.write(ENTER);
      await flush();
      expect(instance.lastFrame()).toContain("Build now");

      instance.stdin.write("\u001B");
      await done;

      expect(decision).toEqual({
        behavior: "deny",
        message: "用户取消计划审批，继续留在 Plan 模式",
      });
    });
  });

  test("永久允许写入失败后保留确认框，用户可改为仅允许本次", async () => {
    const decisions: PermissionDecision[] = [];
    const onDone = mock(() => {});
    const persist = mock(async () => {
      throw new Error("disk unavailable");
    });
    const instance = render(
      <ConfirmDialog
        req={{
          question: "write_file 需要确认",
          toolName: "write_file",
          input: { path: "a.ts" },
          resolve: (decision) => decisions.push(decision),
        }}
        onDone={onDone}
        onAddToAllowList={persist}
      />
    );

    await flush();
    instance.stdin.write("2");
    await flush();

    expect(instance.lastFrame()).toContain("未能保存项目权限规则");
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
          question: "bash 需要确认",
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
    expect(instance.lastFrame()).toContain("正在保存项目权限规则");

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

  test("永久允许对当前 turn 已创建的 ToolContext 立即生效", async () => {
    await withTempProject(async (cwd) => {
      const schema = z.object({ path: z.string() });
      const writeTool: Tool<typeof schema> = {
        name: "write_file",
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
          "write_file",
          "write_file 需要确认",
          { path: "a.ts" }
        );
        secondDecision = await resolvePermission(writeTool, { path: "b.ts" }, ctx);
        completed();
        return { reply: "完成", reason: "completed", iterations: 1 };
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
      expect(instance.lastFrame()).toContain("write_file 需要确认");

      instance.stdin.write("2");
      await done;

      expect(secondDecision).toEqual({ behavior: "allow" });
      expect(instance.lastFrame()).not.toContain("write_file 需要确认");
    });
  });
});
