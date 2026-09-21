import { describe, expect, test } from "bun:test";
import { processSlashCommand } from "../helpers/slash.js";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";
import type {SlashCommandHostContext} from "../../src/slash/types.js";

describe("/mcp slash command", () => {
  test.each(["denied", "pending-approval"] as const)("%s 提供重新授权入口，显式命令才触发重连", async status => {
    await withTempProject(async cwd => {
      const ctx = createTestContext(cwd);
      const reconnected: string[] = [];
      ctx.mcpManager = {
        async waitForRefresh() {},
        async initialize() {},
        getSnapshots: () => [{name: "fixture", source: "project", status, toolCount: 0}],
        getTools: () => [], subscribe: () => () => {}, async closeAll() {},
        async reconnect(name) {reconnected.push(name);},
      };
      const messages: string[] = [];
      const context: SlashCommandHostContext = {history: [], ctx, onEvent: event => {
        if (event.type === "assistant_text") messages.push(event.content);
      }};
      await processSlashCommand("/mcp", context);
      expect(reconnected).toEqual([]);
      expect(messages[0]).toContain(`fixture  ${status}  0 tools  project`);
      expect(messages[0]).toContain("Review authorization: /mcp reconnect fixture");
      await processSlashCommand("/mcp reconnect fixture", context);
      expect(reconnected).toEqual(["fixture"]);
    });
  });

  test("输出 Server 状态且不触发模型", async () => {
    await withTempProject(async (cwd) => {
      const ctx = createTestContext(cwd);
      ctx.mcpManager = {
        async waitForRefresh() {},
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
