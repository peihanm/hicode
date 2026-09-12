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
      expect(result.modelContent).toContain("Unknown tool");
      expect(existsSync(join(cwd, "forbidden.txt"))).toBe(false);
    });
  });

  test("未知白名单配置立即失败", () => {
    expect(() => createToolRuntime({allowedToolNames: ["not-a-tool"]}))
      .toThrow("unknown tool");
  });

  test("内置 web_fetch 直接暴露，无 deferred 工具时不提供 tool_search", async () => {
    await withTempProject(async (cwd) => {
      const runtime = createToolRuntime();
      const initialNames = runtime.getToolSchemas().map(
        (tool) => tool.function.name
      );
      expect(initialNames).not.toContain("tool_search");
      expect(initialNames).toContain("glob");
      expect(initialNames).toContain("web_fetch");

      const blocked = await runtime.executeTool(
        "web_fetch",
        JSON.stringify({ url: "http://127.0.0.1/private" }),
        createTestContext(cwd),
        "blocked-web-fetch"
      );
      expect(blocked.outcome).toBe("denied");
      expect(blocked.modelContent).toContain("blocks private");
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
      expect(hidden.modelContent).toContain("is not loaded");

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
    expect(snapshot).toEqual({ version: 2, loadedNames: ["deferred_lookup"] });

    const restored = createToolRuntime({ additionalTools: [deferredTool] });
    restored.restoreToolDiscovery({
      version: 2,
      loadedNames: ["missing_tool", ...snapshot.loadedNames],
    });
    expect(restored.getToolSchemas().map((tool) => tool.function.name))
      .toContain("deferred_lookup");
    expect(restored.getToolDiscoverySnapshot().loadedNames)
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
        version: 2,
        loadedNames: ["deferred_alpha", "deferred_beta"],
      });
    });
  });

  test("无匹配搜索返回普通结果且不改变 discovery", async () => {
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
      expect(result.outcome).toBe("ok");
      expect(result.modelContent).toContain("cannot install tools");
      expect(runtime.getToolDiscoverySnapshot().loadedNames).toEqual([]);
    });
  });

  test("tool_search 在 schema 描述中按来源列出准确的 deferred 工具名", () => {
    const runtime = createToolRuntime({
      additionalTools: [
        {
          name: "mcp__github__search_issues",
          description: "Search issue bodies",
          parameters: z.object({query: z.string()}),
          exposure: "deferred",
          searchSource: {name: "GitHub", description: "Repository tools"},
          isReadOnly: () => true,
          execute: async () => "ok",
        },
        {
          name: "mcp__browser__navigate",
          description: "Navigate a page",
          parameters: z.object({url: z.string()}),
          exposure: "deferred",
          searchSource: {name: "Browser"},
          isReadOnly: () => true,
          execute: async () => "ok",
        },
      ],
    });

    const searchSchema = runtime.getToolSchemas().find(
      (tool) => tool.function.name === "tool_search"
    );
    expect(searchSchema?.function.description).toContain(
      "mcp__github__search_issues"
    );
    expect(searchSchema?.function.description).toContain(
      "mcp__browser__navigate"
    );
    expect(searchSchema?.function.description).toContain("GitHub (1 tool)");
  });

  test("tool_search 名称清单保持有界并标明省略项", () => {
    const runtime = createToolRuntime({
      additionalTools: Array.from({length: 300}, (_, index) => ({
        name: `mcp__large_catalog__tool_${String(index).padStart(4, "0")}_${"x".repeat(48)}`,
        description: `Remote tool ${index}`,
        parameters: z.object({value: z.string()}),
        exposure: "deferred" as const,
        searchSource: {name: "Large catalog"},
        isReadOnly: () => true,
        execute: async () => "ok",
      })),
    });
    const description = runtime.getToolSchemas().find(
      (tool) => tool.function.name === "tool_search"
    )?.function.description ?? "";

    expect(description.length).toBeLessThan(17_000);
    expect(description).toContain("Large catalog (300 tools)");
    expect(description).toContain("more");
  });

  test("loaded deferred tools 使用有界 LRU 工作集", async () => {
    await withTempProject(async (cwd) => {
      const names = Array.from({length: 25}, (_, index) =>
        `deferred_${String(index + 1).padStart(2, "0")}`
      );
      const runtime = createToolRuntime({
        additionalTools: names.map((name) => ({
          name,
          description: `Deferred tool ${name}`,
          parameters: z.object({}),
          exposure: "deferred" as const,
          isReadOnly: () => true,
          execute: async () => name,
        })),
      });
      runtime.getToolSchemas();
      for (let offset = 0; offset < 24; offset += 10) {
        await runtime.executeTool(
          "tool_search",
          JSON.stringify({query: `select:${names.slice(offset, Math.min(offset + 10, 24)).join(",")}`}),
          createTestContext(cwd),
          `load-${offset}`
        );
      }
      runtime.getToolSchemas();
      const touched = await runtime.executeTool(
        "deferred_01",
        "{}",
        createTestContext(cwd),
        "touch-oldest"
      );
      expect(touched.outcome).toBe("ok");
      await runtime.executeTool(
        "tool_search",
        JSON.stringify({query: "select:deferred_25"}),
        createTestContext(cwd),
        "load-25"
      );

      const snapshot = runtime.getToolDiscoverySnapshot();
      expect(snapshot.version).toBe(2);
      expect(snapshot.loadedNames).toHaveLength(24);
      expect(snapshot.loadedNames).toContain("deferred_01");
      expect(snapshot.loadedNames).not.toContain("deferred_02");
      expect(snapshot.loadedNames).toContain("deferred_25");
      const visible = runtime.getToolSchemas().map((tool) => tool.function.name);
      expect(visible).toContain("deferred_01");
      expect(visible).not.toContain("deferred_02");
      expect(visible).toContain("deferred_25");
    });
  });

  test("单次搜索不会声明加载超过 schema 字符预算的工具", async () => {
    await withTempProject(async (cwd) => {
      const names = ["deferred_large_1", "deferred_large_2", "deferred_large_3"];
      const runtime = createToolRuntime({
        additionalTools: names.map((name) => ({
          name,
          description: name,
          parameters: z.object({}),
          inputJsonSchema: {
            type: "object",
            properties: {
              value: {type: "string", description: "x".repeat(60_000)},
            },
          },
          exposure: "deferred" as const,
          isReadOnly: () => true,
          execute: async () => name,
        })),
      });
      runtime.getToolSchemas();
      const result = await runtime.executeTool(
        "tool_search",
        JSON.stringify({query: `select:${names.join(",")}`}),
        createTestContext(cwd),
        "load-large"
      );

      expect(result.outcome).toBe("ok");
      expect(result.modelContent).toContain(
        "deferred_large_3 — not loaded: working-set budget reached"
      );
      expect(runtime.getToolDiscoverySnapshot().loadedNames).toEqual(
        names.slice(0, 2)
      );
    });
  });
});
