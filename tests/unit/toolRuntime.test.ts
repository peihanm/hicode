import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {readFile} from "node:fs/promises";
import { join } from "node:path";
import { createToolRuntime } from "../../src/tools/registry.js";
import { z } from "zod";
import { createTestContext } from "../helpers/testContext.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("scoped tool runtime", () => {
  test("schema 和执行层都只允许白名单工具", async () => {
    await withTempProject(async (cwd) => {
      const runtime = createToolRuntime({allowedToolNames: ["read_file", "bash"]});
      expect(runtime.toolNames).toEqual(["read_file", "bash"]);
      expect(runtime.getToolSchemas().map((tool) => tool.function.name)).toEqual([
        "read_file",
        "bash",
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

  test("内置 web_fetch 直接暴露，无 MCP 工具时不提供 tool_search", async () => {
    await withTempProject(async (cwd) => {
      const runtime = createToolRuntime();
      const initialNames = runtime.getToolSchemas().map(
        (tool) => tool.function.name
      );
      expect(initialNames).not.toContain("tool_search");
      expect(initialNames).toContain("bash");
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

});

function mcpTool(name = "mcp__fixture__echo", description = "Echo a message") {
  return {
    name, description, mcp: {serverName: "fixture"},
    parameters: z.object({message: z.string()}).strict(),
    isReadOnly: () => true, isConcurrencySafe: () => true,
    execute: async ({message}: {message: string}) => `echo:${message}`,
  };
}
const envelope = (tool: string, args: unknown = {message: "hi"}) => JSON.stringify({tool, arguments: args});

test("MCP 查询返回完整定义，查询与调用都不改变 tools，已知名称可直接调用", async () => {
  await withTempProject(async cwd => {
    const tool = mcpTool();
    const runtime = createToolRuntime({additionalTools: [tool]});
    const ctx = createTestContext(cwd);
    const schemas = runtime.getToolSchemas();
    expect(schemas.map(t => t.function.name)).toEqual(expect.arrayContaining(["mcp_call", "tool_search"]));
    expect(schemas.map(t => t.function.name)).not.toContain(tool.name);
    expect(schemas.find(t => t.function.name === "tool_search")?.function.description).not.toContain(tool.name);
    expect((await runtime.executeTool("mcp_call", envelope(tool.name), ctx, "direct")).modelContent).toBe("echo:hi");
    const result = await runtime.executeTool("tool_search", JSON.stringify({names: [tool.name]}), ctx, "lookup");
    expect(JSON.parse(String(result.modelContent))).toMatchObject({tools: [{name: tool.name, description: tool.description,
      inputSchema: {type: "object", required: ["message"]}}]});
    expect(runtime.getToolSchemas()).toEqual(schemas);
    expect((await runtime.executeTool(tool.name, '{"message":"bypass"}', ctx, "raw")).outcome).toBe("failed");
    expect(runtime.isConcurrencySafe("mcp_call", envelope(tool.name))).toBe(true);
    expect(runtime.isConcurrencySafe("mcp_call", envelope(tool.name, {}))).toBe(false);
  });
});

test("MCP 网关拒绝原生工具、套娃、未授权目标和非法参数", async () => {
  await withTempProject(async cwd => {
    const tool = mcpTool();
    const hidden = mcpTool("mcp__private__echo");
    const runtime = createToolRuntime({additionalTools: [tool, hidden], allowedToolNames: [tool.name]});
    const ctx = createTestContext(cwd);
    for (const input of [envelope("write_file"), envelope("mcp_call"), envelope(hidden.name), envelope(tool.name, []),
      envelope(tool.name, {}), '{"tool":"mcp__fixture__echo"}', "not json", envelope(tool.name, {message: 1})]) {
      expect((await runtime.executeTool("mcp_call", input, ctx, "invalid")).outcome).toBe("failed");
    }
    const lookup = await runtime.executeTool("tool_search", JSON.stringify({names: [hidden.name]}), ctx, "private");
    expect(JSON.parse(String(lookup.modelContent))).toMatchObject({tools: [], missingNames: [hidden.name]});
    const empty = createToolRuntime({additionalTools: [tool], allowedToolNames: ["read_file"]});
    expect(empty.getToolSchemas().map(t => t.function.name)).toEqual(["read_file"]);
    for (const name of ["tool_search", "mcp_call"]) {
      expect(() => createToolRuntime({additionalTools: [{...tool, name}]})).toThrow("reserved");
    }
  });
});

test("搜索 query/names 互斥、默认五个，最多十个，缺失可诊断", async () => {
  await withTempProject(async cwd => {
    const tools = Array.from({length: 15}, (_, i) => mcpTool(`mcp__fixture__echo_${i}`));
    const runtime = createToolRuntime({additionalTools: tools});
    const ctx = createTestContext(cwd);
    const search = (args: unknown) => runtime.executeTool("tool_search", JSON.stringify(args), ctx, "search");
    expect(JSON.parse(String((await search({query: "echo"})).modelContent)).tools).toHaveLength(5);
    expect(JSON.parse(String((await search({query: "echo", limit: 10})).modelContent)).tools).toHaveLength(10);
    for (const args of [{}, {names: []}, {query: "echo", names: [tools[0]!.name]}, {names: [tools[0]!.name], limit: 1},
      {query: "echo", limit: 11}, {names: tools.map(t => t.name)}]) expect((await search(args)).outcome).toBe("failed");
    expect(JSON.parse(String((await search({query: "unrelatedunavailable"})).modelContent)).tools).toEqual([]);
  });
});

test("目标权限与 Hook 只执行一次，Hook 改写后按真实 Schema 复核", async () => {
  await withTempProject(async cwd => {
    const tool = mcpTool();
    const events: string[] = [];
    let approve = 0, execute = 0;
    const runtime = createToolRuntime({additionalTools: [{...tool,
      requiresExplicitApproval: () => true,
      checkPermissions: async () => ({behavior: "ask" as const, message: "fixture"}),
      execute: async () => {execute++; return "done";},
    }], hooks: {enabled: true, hasToolHooks: name => name === tool.name,
      async execute(event) {
        events.push(event.hook_event_name);
        if ("tool_name" in event) expect(event.tool_name).toBe(tool.name);
        return {blocked: false, additionalContexts: [], executions: []};
      }}});
    const ctx = createTestContext(cwd, {permissionMode: "ask", canUseTool: async name => {
      expect(name).toBe(tool.name); approve++; return {behavior: "allow"};
    }});
    expect(runtime.isConcurrencySafe("mcp_call", envelope(tool.name))).toBe(false);
    expect((await runtime.executeTool("mcp_call", envelope(tool.name), ctx, "approved")).outcome).toBe("ok");
    expect(approve).toBe(1); expect(execute).toBe(1);
    expect(events).toEqual(["PreToolUse", "PostToolUse"]);
    const invalid = createToolRuntime({additionalTools: [tool], hooks: {enabled: true, hasToolHooks: () => true,
      async execute() {return {blocked: false, additionalContexts: [], executions: [], updatedInput: {message: 4}};}}});
    expect((await invalid.executeTool("mcp_call", envelope(tool.name), ctx, "rewrite")).outcome).toBe("failed");
    const denied = {...ctx, permissionRules: {allow: [], ask: [], deny: [{toolName: tool.name, source: "host" as const}]}};
    expect((await runtime.executeTool("mcp_call", envelope(tool.name), denied, "blocked")).outcome).toBe("denied");
    expect(execute).toBe(1);
  });
});

test("网关保持只读边界、取消边界和当前 Catalog 校验", async () => {
  await withTempProject(async cwd => {
    const tool = mcpTool();
    let tools = [tool];
    const runtime = createToolRuntime({getAdditionalTools: () => tools});
    const ctx = createTestContext(cwd);
    const schemas = runtime.getToolSchemas();
    tools = [{...tool, parameters: z.object({message: z.string().min(8)}).strict()}];
    expect((await runtime.executeTool("mcp_call", envelope(tool.name), ctx, "changed")).outcome).toBe("failed");
    expect(runtime.getToolSchemas()).toEqual(schemas);
    tools = [{...tool, isReadOnly: () => false}];
    expect((await runtime.executeTool("mcp_call", envelope(tool.name), createTestContext(cwd, {readOnlyTools: true}), "readonly")).outcome).toBe("denied");
    const abort = new AbortController(); abort.abort();
    expect((await runtime.executeTool("mcp_call", envelope(tool.name), createTestContext(cwd, {signal: abort.signal}), "cancel")).outcome).toBe("interrupted");
    tools = [];
    expect((await runtime.executeTool("mcp_call", envelope(tool.name), ctx, "removed")).outcome).toBe("failed");
    expect(runtime.getToolSchemas().map(t => t.function.name)).not.toContain("mcp_call");
  });
});

test("超大搜索结果自动落盘，完整 Schema 保留且 tools 不膨胀", async () => {
  await withTempProject(async cwd => {
    const tool = mcpTool(undefined, "Long description ".repeat(4000));
    const runtime = createToolRuntime({additionalTools: [tool]});
    const ctx = createTestContext(cwd);
    const result = await runtime.executeTool("tool_search", JSON.stringify({names: [tool.name]}), ctx, "large");
    expect(result.outcome).toBe("ok"); expect(result.persisted).toBeDefined();
    expect(result.modelContent).toContain("persisted-output");
    expect(JSON.parse(await readFile(result.persisted!.path, "utf8")).tools[0].description).toBe(tool.description);
    expect(runtime.getToolSchemas().map(t => t.function.name)).not.toContain(tool.name);
  });
});
