import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { StatusBar } from "../../src/ui/status/StatusBar.js";

afterEach(() => cleanup());

function renderStatusBar(
  tokenStatus: "unavailable" | "estimated" | "actual"
): string {
  return (
    render(
      <StatusBar
        cwd="/tmp/project"
        model="glm-4.7"
        permissionMode="default"
        tokenCount={1234}
        percentUsed={0.12}
        warning={false}
        tokenStatus={tokenStatus}
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
    expect(frame).toContain("shift+tab switch mode");
    expect(frame).toContain("ctrl+o transcript");
  });
});
