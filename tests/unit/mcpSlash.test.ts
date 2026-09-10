import { describe, expect, test } from "bun:test";
import { processSlashCommand } from "../helpers/slash.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("/mcp slash command", () => {
  test("输出 Server 状态且不触发模型", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd);
      ctx.mcpManager = {
        async initialize() {},
        getSnapshots: () => [{
          name: "fixture",
          source: "project",
          status: "connected",
          toolCount: 6,
        }],
        getTools: () => [],
        subscribe: () => () => {},
        async closeAll() {},
        async reconnect() {},
      };
      const messages: string[] = [];
      const handled = await processSlashCommand("/mcp", {
        history: [],
        ctx,
        onEvent(event) {
          if (event.type === "assistant_text") messages.push(event.content);
        },
      });
      expect(handled).toBe(true);
      expect(messages[0]).toContain("fixture  connected  6 tools  project");
    });
  });
});
