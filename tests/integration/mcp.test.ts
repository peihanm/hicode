import { describe, expect, test } from "bun:test";
import {mkdir, writeFile} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createMcpManager } from "../../src/mcp/index.js";
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

async function createFixtureManager(cwd: string) {
  const storage = createTestStorage(cwd);
  const userConfigPath = join(storage.pillarHome, "mcp.json");
  await mkdir(storage.pillarHome, {recursive: true});
  await writeFile(userConfigPath, JSON.stringify({
    mcpServers: {
      fixture: {
        type: "stdio",
        command: process.execPath,
        args: [fixture],
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
      await mkdir(storage.pillarHome, {recursive: true});
      await writeFile(join(storage.pillarHome, "mcp.json"), JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [fixture],
            env: {
              PILLAR_TEST_PROVIDER_API_KEY: "override-secret",
              PILLAR_TEST_SAFE_VALUE: "visible",
            },
          },
        },
      }));
      const childEnvironment = createChildProcessEnvironment({
        PATH: process.env.PATH,
        PILLAR_TEST_PROVIDER_API_KEY: "host-secret",
      }, ["PILLAR_TEST_PROVIDER_API_KEY"]);
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
        const ctx = createTestContext(cwd, {permissionMode: "bypassPermissions"});
        const secret = await runtime.executeTool(
          "mcp__fixture__environment",
          JSON.stringify({name: "PILLAR_TEST_PROVIDER_API_KEY"}),
          ctx,
          "mcp-secret-env"
        );
        const safe = await runtime.executeTool(
          "mcp__fixture__environment",
          JSON.stringify({name: "PILLAR_TEST_SAFE_VALUE"}),
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
      const userConfigPath = join(storage.pillarHome, "mcp.json");
      await mkdir(storage.pillarHome, {recursive: true});
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
          permissionMode: "default",
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
        const base64 = Buffer.from("fixture-image").toString("base64");
        expect(result.outcome).toBe("ok");
        expect(result.modelContent).toContain("saved to");
        expect(result.modelContent).toContain("image/png");
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
        permissionMode: "bypassPermissions",
        resumeMode: { kind: "none" },
        outputFormat: "json",
      }, {
        mcpManager: manager,
        agent: { callLLM: fake.callLLM },
        writeOutput: async () => {},
      });
      expect(summary.reply).toBe("MCP complete");
      expect(summary.toolCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({name: "tool_search", outcome: "ok"}),
        expect.objectContaining({name: "mcp__fixture__echo", outcome: "ok"}),
      ]));
      expect(summary.mcpServers[0]).toMatchObject({ name: "fixture", status: "connected", toolCount: 8 });
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
        permissionMode: "bypassPermissions",
        resumeMode: {kind: "session", sessionId: summary.sessionId},
        outputFormat: "json",
      }, {
        mcpManager: resumedManager,
        agent: {callLLM: resumedFake.callLLM},
        writeOutput: async () => {},
      });
      expect(resumed.reply).toBe("MCP resumed");
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
