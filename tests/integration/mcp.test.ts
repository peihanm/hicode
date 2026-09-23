import {contentText} from "../../src/images/content.js";
import { describe, expect, test } from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import { join, resolve } from "node:path";
import {createMcpManager} from "../../src/mcp/manager.js";
import { createToolRuntime } from "../../src/tools/registry.js";
import { runHeadlessForTest as runHeadless } from "../helpers/headless.js";
import { createTestContext } from "../helpers/testContext.js";
import {createTestStorage, withTempProject} from "../helpers/tempProject.js";
import { assistantText, assistantToolCall, createFakeLLM } from "../helpers/fakeLLM.js";
import { createTestSettings } from "../helpers/runtimeResources.js";
import type {ToolRuntime} from "../../src/tools/registry.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";

const fixture = resolve(import.meta.dir, "../fixtures/mcp/stdioServer.ts");
const manyToolsFixture = resolve(
  import.meta.dir,
  "../fixtures/mcp/manyToolsServer.ts"
);
const collaborationToolsFixture = resolve(
  import.meta.dir,
  "../fixtures/mcp/collaborationToolsServer.ts"
);

async function createFixtureManager(cwd: string, fixturePath = fixture) {
  const storage = createTestStorage(cwd);
  const userConfigPath = join(storage.hicodeHome, "mcp.json");
  await mkdir(storage.hicodeHome, {recursive: true});
  await writeFile(userConfigPath, JSON.stringify({
    mcpServers: {
      fixture: {
        type: "stdio",
        command: process.execPath,
        args: [fixturePath],
        timeoutMs: 10_000,
        toolTimeoutMs: 5_000,
      },
    },
  }));
  const manager = createMcpManager({
    storage,
    cwd,
    childEnvironment: testChildEnvironment,
    headless: true,
  });
  await manager.initialize();
  return manager;
}

async function createMultiFixtureManager(cwd: string) {
  const storage = createTestStorage(cwd);
  const userConfigPath = join(storage.hicodeHome, "mcp.json");
  await mkdir(storage.hicodeHome, {recursive: true});
  await writeFile(userConfigPath, JSON.stringify({
    mcpServers: {
      mega_catalog: {
        type: "stdio",
        command: process.execPath,
        args: [manyToolsFixture],
        timeoutMs: 10_000,
        toolTimeoutMs: 5_000,
      },
      collaboration_hub: {
        type: "stdio",
        command: process.execPath,
        args: [collaborationToolsFixture],
        timeoutMs: 10_000,
        toolTimeoutMs: 5_000,
      },
    },
  }));
  const manager = createMcpManager({
    storage,
    cwd,
    childEnvironment: testChildEnvironment,
    headless: true,
  });
  await manager.initialize();
  return manager;
}

async function exposeDeferredTools(
  runtime: ToolRuntime,
  cwd: string,
  ...names: string[]
) {
  runtime.getToolSchemas();
  const result = await runtime.executeTool(
    "tool_search",
    JSON.stringify({query: `select:${names.join(",")}`}),
    createTestContext(cwd),
    `search-${names.join("-")}`
  );
  expect(result.outcome).toBe("ok");
  return runtime.getToolSchemas();
}

describe("MCP stdio integration", () => {
  test("完整本地 Schema 与 Hook 最终校验阻止真实 stdio 请求，坏 Schema 单独诊断", async () => {
    await withTempProject(async cwd => {
      const manager = await createFixtureManager(cwd, resolve(import.meta.dir, "../fixtures/mcp/schemaServer.ts"));
      try {
        expect(manager.getSnapshots()[0]).toMatchObject({status: "connected", toolCount: 2});
        expect(manager.getSnapshots()[0]?.error).toContain("invalid_schema");
        const runtime = createToolRuntime({additionalTools: manager.getTools()});
        const name = "mcp__fixture__validated";
        const stats = "mcp__fixture__stats";
        await exposeDeferredTools(runtime, cwd, name, stats);
        const ctx = createTestContext(cwd);
        for (const args of [{}, {payload: {}}, {payload: {count: "1", mode: "safe"}}, {payload: {count: 1, mode: "unsafe"}}, {payload: {count: 1, mode: "safe", extra: true}}]) {
          expect((await runtime.executeTool(name, JSON.stringify(args), ctx, "invalid")).outcome).toBe("failed");
        }
        expect((await runtime.executeTool(stats, "{}", ctx, "stats-before")).modelContent).toContain("calls:0");
        const hookRuntime = createToolRuntime({additionalTools: manager.getTools(), hooks: {enabled: true, hasToolHooks: () => true, async execute(event) {
          return {blocked: false, additionalContexts: [], executions: [], ...(event.hook_event_name === "PreToolUse" && event.tool_name === name ? {updatedInput: {payload: {count: 0, mode: "safe"}}} : {})};
        }}});
        await exposeDeferredTools(hookRuntime, cwd, name);
        const valid = {payload: {count: 2, mode: "safe"}};
        expect((await hookRuntime.executeTool(name, JSON.stringify(valid), ctx, "hook")).outcome).toBe("failed");
        expect((await runtime.executeTool(stats, "{}", ctx, "stats-hook")).modelContent).toContain("calls:0");
        expect((await runtime.executeTool(name, JSON.stringify(valid), ctx, "valid")).modelContent).toContain(JSON.stringify(valid));
        expect((await runtime.executeTool(stats, "{}", ctx, "stats-after")).modelContent).toContain("calls:1");
      } finally {await manager.closeAll();}
    });
  });
  test("多个大型 MCP 来源共享名称目录并分别按需加载和调用", async () => {
    await withTempProject(async (cwd) => {
      const manager = await createMultiFixtureManager(cwd);
      try {
        expect(manager.getSnapshots()).toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: "mega_catalog",
            status: "connected",
            toolCount: 100,
          }),
          expect.objectContaining({
            name: "collaboration_hub",
            status: "connected",
            toolCount: 60,
          }),
        ]));

        const runtime = createToolRuntime({additionalTools: manager.getTools()});
        const initialSchemas = runtime.getToolSchemas();
        expect(initialSchemas.filter(
          (tool) => tool.function.name.startsWith("mcp__")
        )).toHaveLength(0);
        const searchDescription = initialSchemas.find(
          (tool) => tool.function.name === "tool_search"
        )?.function.description ?? "";
        expect(searchDescription).toContain("mega_catalog (100 tools)");
        expect(searchDescription).toContain("collaboration_hub (60 tools)");
        expect(searchDescription).toContain("mcp__mega_catalog__github_001");
        expect(searchDescription).toContain("mcp__collaboration_hub__slack_000");

        const githubName = "mcp__mega_catalog__github_001";
        const slackName = "mcp__collaboration_hub__slack_000";
        const schemas = await exposeDeferredTools(
          runtime,
          cwd,
          githubName,
          slackName
        );
        expect(schemas.map((tool) => tool.function.name)).toEqual(
          expect.arrayContaining([githubName, slackName])
        );

        const ctx = createTestContext(cwd);
        const [githubResult, slackResult] = await Promise.all([
          runtime.executeTool(
            githubName,
            JSON.stringify({query: "open pull requests", limit: 2}),
            ctx,
            "multi-github"
          ),
          runtime.executeTool(
            slackName,
            JSON.stringify({query: "release blocker", limit: 3}),
            ctx,
            "multi-slack"
          ),
        ]);
        expect(githubResult).toMatchObject({outcome: "ok"});
        expect(githubResult.modelContent).toContain('"tool":"github_001"');
        expect(slackResult).toMatchObject({outcome: "ok"});
        expect(slackResult.modelContent).toContain('"tool":"slack_000"');
      } finally {
        await manager.closeAll();
      }
      expect(manager.getSnapshots().every(
        (snapshot) => snapshot.status === "closed"
      )).toBe(true);
    });
  });

  test("大型 MCP Catalog 只暴露名称并按需加载真实 Schema", async () => {
    await withTempProject(async (cwd) => {
      const manager = await createFixtureManager(cwd, manyToolsFixture);
      try {
        expect(manager.getSnapshots()).toEqual([
          expect.objectContaining({status: "connected", toolCount: 100}),
        ]);
        const runtime = createToolRuntime({additionalTools: manager.getTools()});
        const initialSchemas = runtime.getToolSchemas();
        expect(initialSchemas.filter(
          (tool) => tool.function.name.startsWith("mcp__")
        )).toHaveLength(0);
        const searchDescription = initialSchemas.find(
          (tool) => tool.function.name === "tool_search"
        )?.function.description ?? "";
        expect(searchDescription).toContain("fixture (100 tools)");
        expect(searchDescription).toContain("mcp__fixture__browser_000");
        expect(searchDescription.length).toBeLessThan(17_000);

        const ctx = createTestContext(cwd);
        const searches = [
          ["browser", "browser screenshot inspect DOM"],
          ["github", "repository pull request issue"],
          ["calendar", "meeting attendee available time"],
          ["documents", "knowledge base document pages"],
          ["database", "database schema aggregate records"],
        ] as const;
        for (const [category, query] of searches) {
          const result = await runtime.executeTool(
            "tool_search",
            JSON.stringify({query, limit: 5}),
            ctx,
            `many-${category}`
          );
          expect(result.outcome).toBe("ok");
          expect(contentText(result.modelContent).split("\n")[1]).toContain(
            `mcp__fixture__${category}_`
          );
          runtime.getToolSchemas();
        }

        const snapshot = runtime.getToolDiscoverySnapshot();
        expect(snapshot.loadedNames).toHaveLength(24);
        const callableName = snapshot.loadedNames.at(-1)!;
        const called = await runtime.executeTool(
          callableName,
          JSON.stringify({query: "probe", limit: 3}),
          ctx,
          "many-call"
        );
        expect(called).toMatchObject({outcome: "ok"});
        expect(called.modelContent).toContain('"query":"probe"');

        const resumed = createToolRuntime({additionalTools: manager.getTools()});
        resumed.restoreToolDiscovery(snapshot);
        expect(resumed.getToolDiscoverySnapshot()).toEqual(snapshot);
        expect(resumed.getToolSchemas().filter(
          (tool) => tool.function.name.startsWith("mcp__")
        )).toHaveLength(24);
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("连接、发现、调用和关闭都经过 ToolRuntime", async () => {
    await withTempProject(async (cwd) => {
      const manager = await createFixtureManager(cwd);
      try {
        expect(manager.getSnapshots()).toEqual([
          expect.objectContaining({ name: "fixture", status: "connected", toolCount: 8 }),
        ]);
        const runtime = createToolRuntime({ additionalTools: manager.getTools() });
        const name = "mcp__fixture__echo";
        const initialNames = runtime.getToolSchemas().map((item) => item.function.name);
        expect(initialNames).toContain("tool_search");
        expect(initialNames).not.toContain(name);
        expect(runtime.getToolSchemas().find(
          (item) => item.function.name === "tool_search"
        )?.function.description).toContain(name);
        const schemas = await exposeDeferredTools(runtime, cwd, name);
        expect(schemas.find((item) => item.function.name === name)?.function.parameters)
          .toMatchObject({ type: "object", required: ["message"] });
        expect(runtime.isConcurrencySafe(name, JSON.stringify({ message: "hi" }))).toBe(true);
        const result = await runtime.executeTool(
          name,
          JSON.stringify({ message: "hello" }),
          createTestContext(cwd),
          "mcp-echo"
        );
        expect(result).toMatchObject({ outcome: "ok", modelContent: "echo:hello" });
      } finally {
        await manager.closeAll();
      }
      expect(manager.getSnapshots()[0]?.status).toBe("closed");
    });
  });

  test("MCP 子进程不能继承或由配置重新注入 Secret", async () => {
    await withTempProject(async (cwd, storage) => {
      await mkdir(storage.hicodeHome, {recursive: true});
      await writeFile(join(storage.hicodeHome, "mcp.json"), JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [fixture],
            env: {
              HICODE_TEST_PROVIDER_API_KEY: "override-secret",
              HICODE_TEST_SAFE_VALUE: "visible",
            },
          },
        },
      }));
      const childEnvironment = createChildProcessEnvironment({
        PATH: process.env.PATH,
        HICODE_TEST_PROVIDER_API_KEY: "host-secret",
      }, ["HICODE_TEST_PROVIDER_API_KEY"]);
      const manager = createMcpManager({
        storage,
        cwd,
        childEnvironment,
        headless: true,
      });
      await manager.initialize();
      try {
        const runtime = createToolRuntime({additionalTools: manager.getTools()});
        await exposeDeferredTools(runtime, cwd, "mcp__fixture__environment");
        const ctx = createTestContext(cwd, {permissionMode: "full-access"});
        const secret = await runtime.executeTool(
          "mcp__fixture__environment",
          JSON.stringify({name: "HICODE_TEST_PROVIDER_API_KEY"}),
          ctx,
          "mcp-secret-env"
        );
        const safe = await runtime.executeTool(
          "mcp__fixture__environment",
          JSON.stringify({name: "HICODE_TEST_SAFE_VALUE"}),
          ctx,
          "mcp-safe-env"
        );
        expect(secret.modelContent).toBe("<missing>");
        expect(safe.modelContent).toBe("visible");
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("只读 Annotation 自动放行，破坏性 Tool 询问且单个 Spawn 失败不影响健康 Server", async () => {
    await withTempProject(async (cwd, storage) => {
      const userConfigPath = join(storage.hicodeHome, "mcp.json");
      await mkdir(storage.hicodeHome, {recursive: true});
      await writeFile(userConfigPath, JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: [fixture] },
          broken: { command: join(cwd, "does-not-exist") },
        },
      }));
      const manager = createMcpManager({
        storage,
        cwd,
        childEnvironment: testChildEnvironment,
        headless: true,
      });
      await manager.initialize();
      try {
        expect(manager.getSnapshots()).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "fixture", status: "connected" }),
          expect.objectContaining({ name: "broken", status: "failed" }),
        ]));
        let confirmations = 0;
        const runtime = createToolRuntime({ additionalTools: manager.getTools() });
        const ctx = createTestContext(cwd, {
          permissionMode: "ask",
        collaborationMode: "build",
          canUseTool: async () => {
            confirmations++;
            return { behavior: "allow" };
          },
        });
        await exposeDeferredTools(
          runtime,
          cwd,
          "mcp__fixture__echo",
          "mcp__fixture__mutate"
        );
        const result = await runtime.executeTool(
          "mcp__fixture__echo",
          JSON.stringify({ message: "permission" }),
          ctx,
          "mcp-permission"
        );
        expect(confirmations).toBe(0);
        expect(runtime.isConcurrencySafe("mcp__fixture__mutate", JSON.stringify({ value: "x" })))
          .toBe(false);
        const mutation = await runtime.executeTool(
          "mcp__fixture__mutate",
          JSON.stringify({ value: "permission" }),
          ctx,
          "mcp-mutate-permission"
        );
        expect(confirmations).toBe(1);
        expect(result.modelContent).toBe("echo:permission");
        expect(mutation.modelContent).toBe("mutated:permission");
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("MCP error 进入 failed，大输出复用 Tool Result Store", async () => {
    await withTempProject(async (cwd) => {
      const manager = await createFixtureManager(cwd);
      try {
        const runtime = createToolRuntime({ additionalTools: manager.getTools() });
        const ctx = createTestContext(cwd);
        await exposeDeferredTools(
          runtime,
          cwd,
          "mcp__fixture__fail",
          "mcp__fixture__large_text"
        );
        const failed = await runtime.executeTool("mcp__fixture__fail", "{}", ctx, "mcp-fail");
        expect(failed.outcome).toBe("failed");
        expect(failed.modelContent).toContain("fixture failure");
        const large = await runtime.executeTool(
          "mcp__fixture__large_text",
          JSON.stringify({ size: 60_000 }),
          ctx,
          "mcp-large"
        );
        expect(large.outcome).toBe("ok");
        expect(large.persisted).toBeTruthy();
        expect(large.modelContent).toContain("persisted-output");
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("二进制 MCP Content 保存为 Artifact，Base64 不进入模型结果", async () => {
    await withTempProject(async (cwd) => {
      const manager = await createFixtureManager(cwd);
      try {
        const runtime = createToolRuntime({ additionalTools: manager.getTools() });
        await exposeDeferredTools(runtime, cwd, "mcp__fixture__binary");
        const result = await runtime.executeTool(
          "mcp__fixture__binary",
          "{}",
          createTestContext(cwd),
          "mcp-binary"
        );
        const base64 = Buffer.from("fixture-binary").toString("base64");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain("saved to");
        expect(result.modelContent).toContain("application/octet-stream");
        expect(result.modelContent).not.toContain(base64);
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("AbortSignal 中止长 MCP 调用", async () => {
    await withTempProject(async (cwd) => {
      const manager = await createFixtureManager(cwd);
      try {
        const runtime = createToolRuntime({ additionalTools: manager.getTools() });
        await exposeDeferredTools(runtime, cwd, "mcp__fixture__slow");
        const controller = new AbortController();
        const promise = runtime.executeTool(
          "mcp__fixture__slow",
          JSON.stringify({ delayMs: 5_000 }),
          createTestContext(cwd, { signal: controller.signal }),
          "mcp-slow"
        );
        setTimeout(() => controller.abort("user_escape"), 30);
        const result = await promise;
        expect(result.outcome).toBe("interrupted");
      } finally {
        await manager.closeAll();
      }
    });
  });

  test("Headless 使用动态 MCP Runtime 并输出 Server 状态", async () => {
    await withTempProject(async (cwd) => {
      const manager = await createFixtureManager(cwd);
      const fake = createFakeLLM([
        (call) => {
          expect(call.tools.map((tool) => tool.function.name)).toContain("tool_search");
          expect(call.tools.map((tool) => tool.function.name))
            .not.toContain("mcp__fixture__echo");
          expect(call.tools.find(
            (tool) => tool.function.name === "tool_search"
          )?.function.description).toContain("mcp__fixture__echo");
          return assistantToolCall(
            "tool_search",
            {query: "select:mcp__fixture__echo"},
            "headless-search"
          );
        },
        (call) => {
          expect(call.tools.map((tool) => tool.function.name))
            .toContain("mcp__fixture__echo");
          expect(call.messages.find((item) => item.role === "tool")?.content)
            .toContain("available next request");
          return assistantToolCall(
            "mcp__fixture__echo",
            { message: "headless" },
            "headless-mcp"
          );
        },
        (call) => {
          expect(call.messages.findLast((item) => item.role === "tool")?.content)
            .toBe("echo:headless");
          return assistantText("MCP complete");
        },
      ]);
      const summary = await runHeadless({
        cwd,
        settings: createTestSettings(),
        prompt: "call MCP",
        permissionMode: "full-access",
        collaborationMode: "build",
        resumeMode: { kind: "none" },
        outputFormat: "json",
      }, {
        mcpManager: manager,
        agent: { callLLM: fake.callLLM },
        writeOutput: async () => {},
      });
      expect(summary.finalResponse).toBe("MCP complete");
      expect(summary.items.filter(item => item.type === "tool_call")).toEqual(expect.arrayContaining([
        expect.objectContaining({name: "tool_search", outcome: "ok"}),
        expect.objectContaining({name: "mcp__fixture__echo", outcome: "ok"}),
      ]));
      expect(manager.getSnapshots()[0]?.status).toBe("closed");

      const resumedManager = await createFixtureManager(cwd);
      const resumedFake = createFakeLLM([
        (call) => {
          expect(call.tools.map((tool) => tool.function.name))
            .toContain("mcp__fixture__echo");
          return assistantText("MCP resumed");
        },
      ]);
      const resumed = await runHeadless({
        cwd,
        settings: createTestSettings(),
        prompt: "continue with the loaded MCP tool",
        permissionMode: "full-access",
        collaborationMode: "build",
        resumeMode: {kind: "session", sessionId: summary.threadId},
        outputFormat: "json",
      }, {
        mcpManager: resumedManager,
        agent: {callLLM: resumedFake.callLLM},
        writeOutput: async () => {},
      });
      expect(resumed.finalResponse).toBe("MCP resumed");
      expect(resumedManager.getSnapshots()[0]?.status).toBe("closed");
    });
  });

  test("项目 Server 未批准时不启动，允许后才连接", async () => {
    await withTempProject(async (cwd, storage) => {
      const projectConfigPath = join(cwd, ".mcp.json");
      await writeFile(projectConfigPath, JSON.stringify({
        mcpServers: {
          project_fixture: { command: process.execPath, args: [fixture] },
        },
      }));
      let requests = 0;
      const pending = createMcpManager({
        storage,
        cwd,
        childEnvironment: testChildEnvironment,
        headless: true,
      });
      await pending.initialize();
      expect(pending.getSnapshots()[0]).toMatchObject({ status: "pending-approval", toolCount: 0 });
      await pending.closeAll();

      const allowed = createMcpManager({
        storage,
        cwd,
        childEnvironment: testChildEnvironment,
        requestApproval: async () => {
          requests++;
          return "once";
        },
      });
      await allowed.initialize();
      try {
        expect(requests).toBe(1);
        expect(allowed.getSnapshots()[0]).toMatchObject({ status: "connected", toolCount: 8 });
      } finally {
        await allowed.closeAll();
      }
    });
  });

  test("Host Server 未批准绝不启动，批准后进入同一工具链", async () => {
    await withTempProject(async (cwd, storage) => {
      const hostServers = [{
        name: "host_fixture",
        command: process.execPath,
        args: [fixture],
      }];
      const pending = createMcpManager({
        storage,
        cwd,
        childEnvironment: testChildEnvironment,
        sources: [],
        hostServers,
        headless: true,
      });
      await pending.initialize();
      expect(pending.getSnapshots()[0]).toMatchObject({
        source: "host",
        status: "pending-approval",
        toolCount: 0,
      });
      expect(pending.getTools()).toEqual([]);
      await pending.closeAll();

      let approvals = 0;
      const allowed = createMcpManager({
        storage,
        cwd,
        childEnvironment: testChildEnvironment,
        sources: [],
        hostServers,
        requestApproval: async () => {
          approvals += 1;
          return "once";
        },
      });
      await allowed.initialize();
      try {
        expect(approvals).toBe(1);
        expect(allowed.getSnapshots()[0]).toMatchObject({
          source: "host",
          status: "connected",
          toolCount: 8,
        });
        expect(allowed.getTools().some((tool) =>
          tool.name === "mcp__host_fixture__echo"
        )).toBe(true);
      } finally {
        await allowed.closeAll();
      }
    });
  });
});
