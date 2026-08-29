import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { McpApprovalDialog } from "../../src/ui/bootstrap/McpApprovalDialog.js";

describe("MCP approval UI", () => {
  test("展示安全的 Server 启动信息并返回选择", async () => {
    const view = render(
      <McpApprovalDialog
        request={{
          projectPath: "/tmp/project",
          serverName: "filesystem",
          command: "node",
          args: ["server.js", "--stdio", "--token", "sensitive-value"],
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
  });
});
