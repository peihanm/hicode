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
        permissionMode="default"
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
  });
});

describe("StatusBar background tasks", () => {
  test("用后台服务数量代替容易误解的运行中提示", () => {
    const frame = renderStatusBar("actual", {total: 1, shell: 1, agent: 0, memory: 0});
    expect(frame).toContain("Service 1");
    expect(frame).not.toContain("Tasks running");
  });

  test("区分后台 Agent 与混合任务", () => {
    expect(
      renderStatusBar("actual", {total: 2, shell: 0, agent: 2, memory: 0})
    ).toContain("Background agents 2");
    expect(
      renderStatusBar("actual", {total: 3, shell: 1, agent: 2, memory: 0})
    ).toContain("Background 3");
  });

  test("没有后台任务时不显示摘要", () => {
    const frame = renderStatusBar("actual", {total: 0, shell: 0, agent: 0, memory: 0});
    expect(frame).not.toContain("Service");
    expect(frame).not.toContain("Background");
  });
});
