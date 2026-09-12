import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { StatusBar } from "../../src/ui/status/StatusBar.js";
import type {RunningTaskSummary} from "../../src/tasks/index.js";

afterEach(() => cleanup());

function renderStatusBar(
  tokenStatus: "unavailable" | "estimated" | "actual",
  backgroundTasks?: RunningTaskSummary
): string {
  return (
    render(
      <StatusBar
        cwd="/tmp/project"
        model="glm-4.7"
        permissionMode="ask"
        collaborationMode="build"
        tokenCount={1234}
        percentUsed={0.12}
        warning={false}
        tokenStatus={tokenStatus}
        backgroundTasks={backgroundTasks}
      />
    ).lastFrame() ?? ""
  );
}

describe("StatusBar token state", () => {
  test("长项目路径不会挤掉审批状态和 Plan 标记", () => {
    const instance = render(<StatusBar
      cwd={`/project/${"long-path/".repeat(30)}`} model="Qwen"
      permissionMode="auto-review" collaborationMode="plan"
      tokenCount={0} percentUsed={0} warning={false} tokenStatus="unavailable"
    />);
    expect(instance.lastFrame()).toContain("Qwen | Approve for me | Plan | /project/");
  });
  test("新进程在首次模型调用前明确显示新会话", () => {
    const frame = renderStatusBar("unavailable");
    expect(frame).toContain("new session");
    expect(frame).not.toContain("0 tokens");
    expect(frame).not.toContain("1234 tokens");
  });

  test("恢复估算和真实 usage 使用不同标记", () => {
    expect(renderStatusBar("estimated")).toContain("~1234 tokens (~12%)");
    expect(renderStatusBar("actual")).toContain("1234 tokens (12%)");
  });

  test("保留完整模型、项目路径和快捷键说明", () => {
    const frame = renderStatusBar("actual");
    expect(frame).toContain("glm-4.7 | /tmp/project | 1234 tokens (12%)");
    expect(frame).toContain("shift+tab Build/Plan");
    expect(frame).toContain("ctrl+o transcript");
    expect(frame).not.toContain("esc to cancel");
    expect(frame).not.toContain("? for shortcuts");
    expect(frame).not.toContain("ctrl+t");
  });
});

describe("StatusBar background tasks", () => {
  test("正常 Sandbox 隐藏，异常保留诊断入口", () => {
    const props = {cwd: "/project", model: "Qwen", permissionMode: "ask" as const,
      collaborationMode: "build" as const, tokenCount: 1, percentUsed: 0, warning: false, tokenStatus: "actual" as const};
    const instance = render(<StatusBar {...props} sandboxStatus={{kind: "ready", platform: "macos", warnings: []}}/>);
    expect(instance.lastFrame()).not.toContain("Sandbox");
    instance.unmount();
    const failed = render(<StatusBar {...props} sandboxStatus={{kind: "unavailable", reason: "fixture", warnings: []}}/>);
    expect(failed.lastFrame()).toContain("Sandbox unavailable · /sandbox");
    failed.unmount();
    const full = render(<StatusBar {...props} permissionMode="full-access" sandboxStatus={{kind: "unavailable", reason: "fixture", warnings: []}}/>);
    expect(full.lastFrame()).toContain("Full Access");
    expect(full.lastFrame()).not.toContain("Sandbox unavailable");
  });
  test("用后台服务数量代替容易误解的运行中提示", () => {
    const frame = renderStatusBar("actual", {total: 1, shell: 1, agent: 0, memory: 0});
    expect(frame).toContain("Background 1 · /tasks");
    expect(frame).not.toContain("Tasks running");
  });

  test("区分后台 Agent 与混合任务", () => {
    expect(
      renderStatusBar("actual", {total: 2, shell: 0, agent: 2, memory: 0})
    ).toContain("Background 2 · /tasks");
    expect(
      renderStatusBar("actual", {total: 3, shell: 1, agent: 2, memory: 0})
    ).toContain("Background 3 · /tasks");
  });

  test("没有后台任务时不显示摘要", () => {
    const frame = renderStatusBar("actual", {total: 0, shell: 0, agent: 0, memory: 0});
    expect(frame).not.toContain("Service");
    expect(frame).not.toContain("Background");
  });
});
