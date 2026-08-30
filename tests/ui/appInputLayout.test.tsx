import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { AppForTest as App } from "../helpers/AppForTest.js";
import { createTestRuntimeResources } from "../helpers/runtimeResources.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createSubagentRegistry } from "../../src/subagents/index.js";

afterEach(() => cleanup());

describe("App input cursor layout", () => {
  test("启动时只显示一次有界的 Agent 加载警告", async () => {
    await withTempProject(async (cwd) => {
      const subagents = createSubagentRegistry({
        definitions: [],
        issues: [{
          source: "project",
          path: `${cwd}/.pillar/agents/broken.md`,
          severity: "error",
          message: "broken",
        }],
      });
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd, {subagents})}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("自定义 Agent 加载存在 1 个错误");
      expect(frame).toContain("输入 /agents 查看详情");
      expect(frame.match(/自定义 Agent 加载存在/g)).toHaveLength(1);
    });
  });

  test("输入内容上方留白、下方紧贴分隔线并保留状态栏顺序", async () => {
    await withTempProject(async (cwd) => {
      const instance = render(
        <App
          resources={createTestRuntimeResources(cwd)}
        />
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(instance.frames.join("\n")).toContain(
        "◆ PILLAR"
      );

      instance.stdin.write("输入法定位");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const frame = instance.lastFrame() ?? "";
      const lines = frame.trimEnd().split("\n");
      const inputLineIndex = lines.findIndex((line) =>
        line.includes("❯ 输入法定位")
      );
      expect(inputLineIndex).toBeGreaterThan(0);
      expect(lines[inputLineIndex - 1]).toBe("");
      expect(lines[inputLineIndex + 1]).toMatch(/^─+$/);
      expect(frame).toContain("ctrl+o transcript");
      expect(frame).not.toContain("esc to cancel");
    });
  });

  test("空闲时 Ctrl+C 先清空非空输入草稿", async () => {
    await withTempProject(async (cwd) => {
      const instance = render(
        <App resources={createTestRuntimeResources(cwd)} />
      );
      await new Promise((resolve) => setTimeout(resolve, 20));

      instance.stdin.write("这段草稿应该被清空");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instance.lastFrame()).toContain("❯ 这段草稿应该被清空");

      instance.stdin.write("\x03");
      await new Promise((resolve) => setTimeout(resolve, 20));

      const frame = instance.lastFrame() ?? "";
      expect(frame).not.toContain("这段草稿应该被清空");
      expect(frame).toContain("❯");
      expect(frame).toContain(cwd);

      instance.stdin.write("一\n二\n三\n四");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instance.lastFrame()).toContain("[Pasted text #1 +3 lines]");
      instance.stdin.write("\x03");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instance.lastFrame()).not.toContain("[Pasted text #1");
    });
  });
});
