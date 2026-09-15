import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import stringWidth from "string-width";
import type {McpApprovalDecision, McpApprovalRequest} from "../../src/mcp/index.js";
import { McpApprovalDialog } from "../../src/ui/bootstrap/McpApprovalDialog.js";

afterEach(cleanup);
const flush = () => new Promise(resolve => setTimeout(resolve, 25));
const request: McpApprovalRequest = {
  projectPath: "/tmp/project",
  serverName: "playwright",
  command: "npx",
  args: ["-y", "@playwright/mcp@latest", "--browser", "chrome"],
  configHash: "hidden-hash",
};

describe("MCP approval UI", () => {
  test("无竖线布局突出服务与启动命令，保留敏感参数脱敏", () => {
    const view = render(
      <McpApprovalDialog
        request={{
          projectPath: "/tmp/project",
          serverName: "filesystem",
          command: "node",
          args: ["server.js", "--stdio", "--token", "sensitive-value", "--api-key=private-key"],
          configHash: "hidden-hash",
        }}
        onDecision={() => {}}
      />
    );
    expect(view.lastFrame()).toContain("filesystem");
    expect(view.lastFrame()).toContain("node");
    expect(view.lastFrame()).toContain("server.js --stdio");
    expect(view.lastFrame()).not.toContain("sensitive-value");
    expect(view.lastFrame()).not.toContain("hidden-hash");
    expect(view.lastFrame()).not.toContain("private-key");
    expect(view.lastFrame()).toContain("[REDACTED]");
    expect(view.lastFrame()).toContain("◆ MCP CONNECTION");
    expect(view.lastFrame()).toContain("COMMAND");
    expect(view.lastFrame()).toContain("PROJECT");
    expect(view.lastFrame()).toContain("❯ 1. Allow once");
    expect(view.lastFrame()).toContain("Start now. Ask again next time.");
    expect(view.lastFrame()).not.toContain("│");
  });

  test.each([
    ["1", "once"], ["2", "always"], ["3", "deny"], ["\u001b", "skip"],
  ] as const)("快捷键 %j 返回 %s，重复输入不重复提交", async (key, expected) => {
    const decisions: McpApprovalDecision[] = [];
    const view = render(<McpApprovalDialog request={request} onDecision={value => decisions.push(value)}/>);
    await flush();
    view.stdin.write(key);
    await flush();
    view.stdin.write("\r");
    await flush();
    expect(decisions).toEqual([expected]);
  });

  test("方向键切换授权范围说明，Enter 确认当前选项", async () => {
    const decisions: McpApprovalDecision[] = [];
    const view = render(<McpApprovalDialog request={request} onDecision={value => decisions.push(value)}/>);
    await flush();
    view.stdin.write("\u001b[A");
    await flush();
    expect(view.lastFrame()).toContain("❯ 3. Deny");
    view.stdin.write("\u001b[A");
    await flush();
    expect(view.lastFrame()).toContain("❯ 2. Always allow for this project");
    expect(view.lastFrame()).toContain("Ask again if configuration changes.");
    expect(decisions).toEqual([]);
    view.stdin.write("\u001b[B");
    await flush();
    view.stdin.write("\u001b[A");
    await flush();
    view.stdin.write("\r");
    await flush();
    expect(decisions).toEqual(["always"]);
  });

  test("长路径和命令随 resize 换行，保持选中项且空闲不刷新", async () => {
    const projectPath = "/tmp/工作目录/嵌套项目/browser-automation-demo";
    const view = render(<McpApprovalDialog request={{...request, projectPath}} onDecision={() => {}}/>);
    let columns = 80;
    Object.defineProperty(view.stdout, "columns", {configurable: true, get: () => columns});
    await flush();
    view.stdin.write("\u001b[B");
    await flush();
    for (const width of [40, 24, 100]) {
      columns = width;
      view.stdout.emit("resize");
      await new Promise(resolve => setTimeout(resolve, 110));
      const frame = view.lastFrame() ?? "";
      expect(frame.split("\n").every(line => stringWidth(line) <= width)).toBe(true);
      expect(frame.replace(/\s/g, "")).toContain(projectPath);
      expect(frame.replace(/\s/g, "")).toContain("npx-y@playwright/mcp@latest--browserchrome");
      expect(frame.replace(/\s/g, "")).toContain("❯2.Alwaysallowforthisproject");
    }
    const frameCount = view.frames.length;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(view.frames.length).toBe(frameCount);
  });
});
