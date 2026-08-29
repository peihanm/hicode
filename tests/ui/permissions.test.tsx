import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { z } from "zod";
import type { AgentRunner } from "../../src/agent/index.js";
import { resolvePermission } from "../../src/permissions/resolvePermission.js";
import type { PermissionDecision, PermissionMode } from "../../src/permissions/types.js";
import type { Tool } from "../../src/tools/types.js";
import { AppForTest as App } from "../helpers/AppForTest.js";
import { ConfirmDialog } from "../../src/ui/dialogs/ConfirmDialog.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTestRuntimeResources } from "../helpers/runtimeResources.js";

afterEach(() => cleanup());

const ENTER = "\r";

async function flush(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("permission confirmation UI", () => {
  test("权限问题、选项和操作提示位于同一个确认框内", async () => {
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
    expect(frame).toContain("◆ Permission request");
    expect(frame).toContain("bash 需要确认");
    expect(frame).toContain("❯ 1. Yes");
    expect(frame).toContain("↑↓ 选择 · Enter 确认 · Esc 取消");
    expect(frame.split("\n").every((line) => line.startsWith("│"))).toBe(true);
  });

  test("exit_plan_mode 使用专用三项审批并更新当前 Session 模式", async () => {
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
          initialPermissionMode="plan"
          runAgentImpl={runAgentImpl}
        />
      );
      await flush(10);
      instance.stdin.write("提交计划");
      await flush(10);
      instance.stdin.write(ENTER);
      await flush();

      expect(instance.lastFrame()).toContain("Ready to code?");
      expect(instance.lastFrame()).toContain("Explore commands and workflows");
      expect(instance.lastFrame()).toContain("3. No, keep planning");
      instance.stdin.write(ENTER);
      await done;

      expect(modeAfterApproval).toBe("acceptEdits");
      expect(instance.lastFrame()).not.toContain("Ready to code?");
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
          initialPermissionMode="plan"
          runAgentImpl={runAgentImpl}
        />
      );
      await flush(10);
      instance.stdin.write("提交计划");
      await flush(10);
      instance.stdin.write(ENTER);
      await flush();
      expect(instance.lastFrame()).toContain("Ready to code?");

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
