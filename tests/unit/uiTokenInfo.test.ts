import { describe, expect, test } from "bun:test";
import { estimateRestoredTokenInfo } from "../../src/ui/turn/tokenInfo.js";
import { EMPTY_PROJECT_INSTRUCTIONS } from "../../src/prompt/instructions.js";

describe("restored session token info", () => {
  test("按真实 invoke 消息和工具 schema 估算恢复会话的首屏占用", () => {
    const withoutTool = estimateRestoredTokenInfo(
      [
        { role: "system", content: "system prompt" },
        { role: "user", origin: "user" as const, content: "previous question" },
        { role: "assistant", content: "previous answer" },
      ],
      [],
      EMPTY_PROJECT_INSTRUCTIONS,
      [],
      "glm-4.7"
    );
    const withTool = estimateRestoredTokenInfo(
      [
        { role: "system", content: "system prompt" },
        { role: "user", origin: "user" as const, content: "previous question" },
        { role: "assistant", content: "previous answer" },
      ],
      [],
      EMPTY_PROJECT_INSTRUCTIONS,
      [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      "glm-4.7"
    );

    expect(withoutTool.status).toBe("estimated");
    expect(withoutTool.count).toBeGreaterThan(0);
    expect(withTool.count).toBeGreaterThan(withoutTool.count);
    expect(withTool.percentUsed).toBeGreaterThan(0);
  });
});

test("恢复和模型切换后的 UI 百分比使用配置窗口", () => {
  const messages = [{role: "user" as const, origin: "user" as const, content: "x".repeat(2000)}];
  const normal = estimateRestoredTokenInfo(messages, [], EMPTY_PROJECT_INSTRUCTIONS, [], "deepseek-flash");
  const configured = estimateRestoredTokenInfo(messages, [], EMPTY_PROJECT_INSTRUCTIONS, [], "deepseek-flash",
    {windowTokens: 1_000_000, autoCompactTokenLimit: 900_000});
  expect(normal.percentUsed).toBeCloseTo(normal.count / 480_000);
  expect(configured.percentUsed).toBeCloseTo(configured.count / 980_000);
});
