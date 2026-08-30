import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createToolRuntime } from "../../src/tools/registry.js";
import { z } from "zod";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("scoped tool runtime", () => {
  test("schema 和执行层都只允许白名单工具", async () => {
    await withTempProject(async (cwd) => {
      const runtime = createToolRuntime({allowedToolNames: ["read_file", "grep"]});
      expect(runtime.toolNames).toEqual(["read_file", "grep"]);
      expect(runtime.getToolSchemas().map((tool) => tool.function.name)).toEqual([
        "read_file",
        "grep",
      ]);
      expect(
        runtime.isConcurrencySafe(
          "read_file",
          JSON.stringify({ path: "package.json" })
        )
      ).toBe(true);
      expect(runtime.isConcurrencySafe("write_file", "{}")).toBe(false);
      expect(runtime.isConcurrencySafe("read_file", "not-json")).toBe(false);

      const result = await runtime.executeTool(
        "write_file",
        JSON.stringify({ path: "forbidden.txt", content: "no" }),
        createTestContext(cwd),
        "forbidden-call"
      );
      expect(result.outcome).toBe("failed");
      expect(result.modelContent).toContain("未知工具");
      expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
    });
  });

  test("未知白名单配置立即失败", () => {
    expect(() => createToolRuntime({allowedToolNames: ["not-a-tool"]}))
      .toThrow("未知工具");
  });

  test("内置 web_fetch 默认 deferred，可由 tool_search 按需加载", async () => {
    await withTempProject(async (cwd) => {
      const runtime = createToolRuntime();
      const initialNames = runtime.getToolSchemas().map(
        (tool) => tool.function.name
      );
      expect(initialNames).toContain("tool_search");
      expect(initialNames).toContain("glob");
      expect(initialNames).not.toContain("web_fetch");

      const search = await runtime.executeTool(
        "tool_search",
        JSON.stringify({ query: "select:web_fetch" }),
        createTestContext(cwd),
        "load-web-fetch"
      );
      expect(search.outcome).toBe("ok");
      expect(runtime.getToolSchemas().map((tool) => tool.function.name))
        .toContain("web_fetch");

      const blocked = await runtime.executeTool(
        "web_fetch",
        JSON.stringify({ url: "http://127.0.0.1/private" }),
        createTestContext(cwd),
        "blocked-web-fetch"
      );
      expect(blocked.outcome).toBe("denied");
      expect(blocked.modelContent).toContain("禁止访问私网");
    });
  });

  test("deferred 工具必须搜索并经过下一次 schema 请求后才能调用", async () => {
    await withTempProject(async (cwd) => {
      const runtime = createToolRuntime({
        additionalTools: [{
          name: "deferred_echo",
          description: "Echo a deferred message",
          parameters: z.object({ message: z.string() }),
          exposure: "deferred",
          searchHint: "echo delayed message",
          isReadOnly: () => true,
          isConcurrencySafe: () => true,
          execute: async ({ message }) => `echo:${message}`,
        }],
      });

      expect(runtime.getToolSchemas().map((tool) => tool.function.name))
        .toContain("tool_search");
      expect(runtime.getToolSchemas().map((tool) => tool.function.name))
        .not.toContain("deferred_echo");

      const hidden = await runtime.executeTool(
        "deferred_echo",
        JSON.stringify({ message: "early" }),
        createTestContext(cwd),
        "early"
      );
      expect(hidden.outcome).toBe("failed");
      expect(hidden.modelContent).toContain("尚未加载");

      const search = await runtime.executeTool(
        "tool_search",
        JSON.stringify({ query: "select:deferred_echo" }),
        createTestContext(cwd),
        "search"
      );
      expect(search.outcome).toBe("ok");
      expect(search.modelContent).toContain("available next request");

      const sameRequest = await runtime.executeTool(
        "deferred_echo",
        JSON.stringify({ message: "same" }),
        createTestContext(cwd),
        "same-request"
      );
      expect(sameRequest.outcome).toBe("failed");

      expect(runtime.getToolSchemas().map((tool) => tool.function.name))
        .toContain("deferred_echo");
      const loaded = await runtime.executeTool(
        "deferred_echo",
        JSON.stringify({ message: "later" }),
        createTestContext(cwd),
        "later"
      );
      expect(loaded).toMatchObject({ outcome: "ok", modelContent: "echo:later" });
    });
  });

  test("discovery snapshot 只恢复当前 runtime 中仍存在的 deferred 工具", async () => {
    const deferredTool = {
      name: "deferred_lookup",
      description: "Lookup deferred data",
      parameters: z.object({}),
      exposure: "deferred" as const,
      isReadOnly: () => true,
      execute: async () => "ok",
    };
    const first = createToolRuntime({ additionalTools: [deferredTool] });
    first.getToolSchemas();
    await first.executeTool(
      "tool_search",
      JSON.stringify({ query: "select:deferred_lookup" }),
      createTestContext(process.cwd()),
      "discover"
    );
    const snapshot = first.getToolDiscoverySnapshot();
    expect(snapshot).toEqual({ version: 1, discoveredNames: ["deferred_lookup"] });

    const restored = createToolRuntime({ additionalTools: [deferredTool] });
    restored.restoreToolDiscovery({
      version: 1,
      discoveredNames: ["missing_tool", ...snapshot.discoveredNames],
    });
    expect(restored.getToolSchemas().map((tool) => tool.function.name))
      .toContain("deferred_lookup");
    expect(restored.getToolDiscoverySnapshot().discoveredNames)
      .toEqual(["deferred_lookup"]);

    const isolated = createToolRuntime({additionalTools: [deferredTool]});
    expect(isolated.getToolSchemas().map((tool) => tool.function.name))
      .not.toContain("deferred_lookup");
  });

  test("并发搜索合并 discovery set 且 schema 不重复", async () => {
    await withTempProject(async (cwd) => {
      const deferredTools = ["deferred_alpha", "deferred_beta"].map((name) => ({
        name,
        description: `Lookup ${name}`,
        parameters: z.object({}),
        exposure: "deferred" as const,
        isReadOnly: () => true,
        execute: async () => name,
      }));
      const runtime = createToolRuntime({additionalTools: deferredTools});
      runtime.getToolSchemas();
      await Promise.all(deferredTools.map((tool, index) =>
        runtime.executeTool(
          "tool_search",
          JSON.stringify({query: `select:${tool.name}`}),
          createTestContext(cwd),
          `parallel-search-${index}`
        )
      ));

      const names = runtime.getToolSchemas().map((tool) => tool.function.name);
      expect(names.filter((name) => name === "deferred_alpha")).toHaveLength(1);
      expect(names.filter((name) => name === "deferred_beta")).toHaveLength(1);
      expect(runtime.getToolDiscoverySnapshot()).toEqual({
        version: 1,
        discoveredNames: ["deferred_alpha", "deferred_beta"],
      });
    });
  });

  test("无匹配搜索返回 failed 且不改变 discovery", async () => {
    await withTempProject(async (cwd) => {
      const runtime = createToolRuntime({
        additionalTools: [{
          name: "deferred_echo",
          description: "Echo a message",
          parameters: z.object({}),
          exposure: "deferred",
          isReadOnly: () => true,
          execute: async () => "ok",
        }],
      });
      runtime.getToolSchemas();
      const result = await runtime.executeTool(
        "tool_search",
        JSON.stringify({query: "database migration"}),
        createTestContext(cwd),
        "no-match"
      );
      expect(result.outcome).toBe("failed");
      expect(runtime.getToolDiscoverySnapshot().discoveredNames).toEqual([]);
    });
  });
});
