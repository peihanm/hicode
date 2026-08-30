import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { loadLspConfig } from "../../src/lsp/config.js";
import { formatDiagnosticsSummary } from "../../src/lsp/diagnostics.js";
import {createLspManager} from "../../src/lsp/manager.js";
import {
  abortableDelay,
  createTurnAbortController,
} from "../../src/runtime/abort.js";
import {
  createLSPServerInstanceFactory,
} from "../../src/lsp/serverInstance.js";
import type { LSPClient } from "../../src/lsp/client.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createFakeLspManager } from "../helpers/fakeLsp.js";
import { createTestContext } from "../helpers/testContext.js";
import { executeTool } from "../helpers/executeTool.js";
import { getPostWriteDiagnostics } from "../../src/tools/shared/lspDiagnostics.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

function diagnostic(index: number, severity: Diagnostic["severity"] = 1): Diagnostic {
  return {
    range: {
      start: { line: index, character: 2 },
      end: { line: index, character: 3 },
    },
    severity,
    source: "test-lsp",
    code: `E${index}`,
    message: `problem ${index}\nwith details`,
  };
}

describe("LSP config and diagnostics", () => {
  test("用户配置被加载并按扩展名路由", async () => {
    await withTempProject(async (cwd, storage) => {
      await mkdir(storage.pillarHome, {recursive: true});
      await writeFile(
        join(storage.pillarHome, "lsp.json"),
        JSON.stringify({
          "test-language-server": {
            command: "never-started-in-test",
            args: ["--stdio"],
            extensions: [".foo"],
          },
        })
      );

      const config = await loadLspConfig(storage, cwd);
      expect(config["test-language-server"]).toMatchObject({
        command: "never-started-in-test",
        extensions: [".foo"],
      });

      const manager = await createLspManager(
        storage,
        cwd,
        testChildEnvironment
      );
      expect(manager).toBeDefined();
      try {
        expect(manager!.getServerForFile("src/example.foo")?.name).toBe(
          "test-language-server"
        );
        expect(manager!.getServerForFile("src/example.FOO")?.name).toBe(
          "test-language-server"
        );
        expect(manager!.getServerForFile("src/example.unknown")).toBeUndefined();
        expect(manager!.listServers()).toContainEqual({
          name: "test-language-server",
          state: "stopped",
          extensions: [".foo"],
        });
      } finally {
        await manager!.shutdown();
      }
    });
  });

  test("损坏的用户配置不会阻止启动", async () => {
    await withTempProject(async (cwd, storage) => {
      await mkdir(storage.pillarHome, {recursive: true});
      await writeFile(join(storage.pillarHome, "lsp.json"), "{invalid");
      await expect(loadLspConfig(storage, cwd)).resolves.toBeDefined();
    });
  });

  test("项目 LSP 命令配置不会进入 Runtime", async () => {
    await withTempProject(async (cwd, storage) => {
      await mkdir(join(cwd, ".pillar"), {recursive: true});
      await writeFile(join(cwd, ".pillar", "lsp.json"), JSON.stringify({
        untrusted: {
          command: "project-command-must-not-run",
          extensions: [".untrusted"],
        },
      }));
      const config = await loadLspConfig(storage, cwd);
      expect(config.untrusted).toBeUndefined();
    });
  });

  test("diagnostics 格式化行列、等级和多行消息", () => {
    const result = formatDiagnosticsSummary("src/a.ts", [diagnostic(4, 2)]);
    expect(result).toContain("1 issue");
    expect(result).toContain("warning [test-lsp] E4 src/a.ts:5:3");
    expect(result).toContain("problem 4 with details");
  });

  test("空 diagnostics 和超过 20 条时输出稳定摘要", () => {
    expect(formatDiagnosticsSummary("src/a.ts", [])).toBe(
      "LSP diagnostics for src/a.ts: no issues."
    );
    const result = formatDiagnosticsSummary(
      "src/a.ts",
      Array.from({ length: 25 }, (_, index) => diagnostic(index))
    );
    expect(result).toContain("25 issues");
    expect(result).toContain("5 more diagnostics omitted");
    expect(result).not.toContain("E24");
  });
});

describe("LSP cancellation", () => {
  test("diagnostics waiter 响应 turn signal", async () => {
    await withTempProject(async (cwd, storage) => {
      const manager = await createLspManager(
        storage,
        cwd,
        testChildEnvironment
      );
      expect(manager).toBeDefined();
      const controller = createTurnAbortController();
      const pending = manager!.waitForDiagnostics(
        "missing.ts",
        10_000,
        0,
        controller.signal
      );
      controller.abort("user-cancel");
      await expect(pending).rejects.toMatchObject({
        name: "TurnInterruptedError",
        reason: "user-cancel",
      });
      await manager!.shutdown();
    });
  });

  test("初始化取消不会消耗 crash recovery budget", async () => {
    let cancelInitialize = true;
    const createClient = (): LSPClient => ({
      get isInitialized() {
        return false;
      },
      async start() {},
      async initialize(_params, signal) {
        if (cancelInitialize) {
          await abortableDelay(10_000, signal!);
        }
        return { capabilities: {} };
      },
      async sendRequest<T>() {
        return undefined as T;
      },
      async sendNotification() {},
      onNotification() {},
      async stop() {},
    });

    const server = createLSPServerInstanceFactory({ createClient })(
      "test",
      {
        command: "unused",
        args: [],
        extensions: [".ts"],
        workspaceFolder: "/project",
      },
      testChildEnvironment,
      undefined
    );

    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = createTurnAbortController();
      const starting = server.start(controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort("user-cancel");
      await expect(starting).rejects.toMatchObject({
        name: "TurnInterruptedError",
      });
      expect(server.state).toBe("stopped");
    }

    cancelInitialize = false;
    await server.start(createTurnAbortController().signal);
    expect(server.state).toBe("running");
    await server.stop();
  });

  test("并发 start 共享同一次进程启动与 initialize", async () => {
    let createCount = 0;
    let startCount = 0;
    let initializeCount = 0;
    let initialized = false;
    const createClient = (): LSPClient => {
      createCount++;
      return {
        get isInitialized() {
          return initialized;
        },
        async start() {
          startCount++;
        },
        async initialize() {
          initializeCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          initialized = true;
          return {capabilities: {}};
        },
        async sendRequest<T>() {
          return undefined as T;
        },
        async sendNotification() {},
        onNotification() {},
        async stop() {
          initialized = false;
        },
      };
    };
    const server = createLSPServerInstanceFactory({createClient})(
      "test",
      {
        command: "unused",
        args: [],
        extensions: [".ts"],
        workspaceFolder: "/project",
      },
      testChildEnvironment
    );

    await Promise.all([server.start(), server.start(), server.start()]);
    expect({createCount, startCount, initializeCount}).toEqual({
      createCount: 1,
      startCount: 1,
      initializeCount: 1,
    });
    expect(server.isHealthy()).toBe(true);
    await server.stop();
  });
});

describe("LSP context isolation", () => {
  test("lsp tool 只调用当前 ToolContext 注入的 manager", async () => {
    await withTempProject(async (cwd) => {
      const fakeA = createFakeLspManager(cwd, "manager-a");
      const fakeB = createFakeLspManager(cwd, "manager-b");
      const args = JSON.stringify({
        operation: "workspaceSymbol",
        filePath: "src/index.ts",
        query: "manager",
      });

      const resultA = await executeTool(
        "lsp",
        args,
        createTestContext(cwd, { lspManager: fakeA.manager })
      );
      const resultB = await executeTool(
        "lsp",
        args,
        createTestContext(cwd, { lspManager: fakeB.manager })
      );

      expect(resultA).toContain("manager-a");
      expect(resultA).not.toContain("manager-b");
      expect(resultB).toContain("manager-b");
      expect(fakeA.state.requests).toEqual(["workspace/symbol"]);
      expect(fakeB.state.requests).toEqual(["workspace/symbol"]);

      const missing = await executeTool(
        "lsp",
        args,
        createTestContext(cwd)
      );
      expect(missing).toBe("LSP 未初始化。");
    });
  });

  test("写后 diagnostics 只读取当前 ToolContext manager", async () => {
    await withTempProject(async (cwd) => {
      const fakeA = createFakeLspManager(cwd, "manager-a", {
        diagnostics: [diagnostic(0, 2)],
      });
      const fakeB = createFakeLspManager(cwd, "manager-b", {
        diagnostics: [
          {
            ...diagnostic(1, 1),
            source: "manager-b",
            message: "only from manager b",
          },
        ],
      });

      const resultA = await getPostWriteDiagnostics(
        join(cwd, "a.ts"),
        "const a = 1;",
        createTestContext(cwd, { lspManager: fakeA.manager })
      );
      const resultB = await getPostWriteDiagnostics(
        join(cwd, "b.ts"),
        "const b = 1;",
        createTestContext(cwd, { lspManager: fakeB.manager })
      );

      expect(resultA).toContain("test-lsp");
      expect(resultA).not.toContain("manager-b");
      expect(resultB).toContain("manager-b");
      expect(resultB).toContain("only from manager b");
      expect(
        await getPostWriteDiagnostics(
          join(cwd, "none.ts"),
          "",
          createTestContext(cwd)
        )
      ).toBe("");
    });
  });

  test("受限 child 的 lsp 路径不能越过 workspace boundary", async () => {
    await withTempProject(async (cwd) => {
      const fake = createFakeLspManager(cwd, "bounded");
      const result = await executeTool(
        "lsp",
        JSON.stringify({
          operation: "documentSymbol",
          filePath: join(cwd, "..", "outside.ts"),
        }),
        createTestContext(cwd, {
          lspManager: fake.manager,
          workspaceBoundary: cwd,
        })
      );
      expect(result).toContain("路径越界");
      expect(fake.state.requests).toEqual([]);
    });
  });
});
