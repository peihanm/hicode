import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import {InteractiveShutdown} from "../../src/cli/interactiveShutdown.js";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import {useState} from "react";
import { createRuntimeBootstrap } from "../../src/ui/bootstrap/RuntimeBootstrap.js";
import {
  createTestRuntimeResources,
  createTestRootConfiguration,
  createTestSettings,
} from "../helpers/runtimeResources.js";
import { withTempProject } from "../helpers/tempProject.js";
import {type LoadedSession} from "../../src/session/index.js";
import type {HookTrustRequest, HookTrustDecision} from "../../src/hooks/types.js";
import type {McpApprovalRequest, McpApprovalDecision, McpServerSnapshot, McpManagerLike} from "../../src/mcp/index.js";

afterEach(() => cleanup());

describe("RuntimeBootstrap lifecycle", () => {
  test("startup shows the input area and context before enabling input", async () => {
    await withTempProject(async (cwd, storage) => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => {release = resolve;});
      const resources = createTestRuntimeResources(cwd);
      const shutdown = new InteractiveShutdown();
      const configuration = createTestRootConfiguration(cwd, createTestSettings(), storage);
      const RuntimeBootstrap = createRuntimeBootstrap({createResources: async () => {
        await gate;
        return resources;
      }});
      const instance = render(<RuntimeBootstrap shutdown={shutdown} configuration={configuration}/>);
      try {
        await new Promise(resolve => setTimeout(resolve, 30));
        const loading = instance.lastFrame()!;
        expect(loading).toContain("Starting HiCode…");
        expect(loading).toContain("❯ Ask HiCode to build, inspect, or fix something");
        expect(loading.indexOf("Starting HiCode…")).toBeLessThan(loading.indexOf("❯ Ask HiCode"));
        expect(loading).not.toContain("❯ Starting HiCode");
        expect(loading).toContain(configuration.settings.models.primary.label);
        expect(loading).toContain("Ctrl+C to exit");
        expect(loading).not.toContain("Initializing Runtime");
        expect(loading).not.toContain("ctrl+o transcript");
        expect(loading).toContain("╔");
        expect(loading).toContain("╚");
        instance.stdin.write("/help\r");
        release();
        await new Promise(resolve => setTimeout(resolve, 80));
        expect(instance.lastFrame()).toContain("Ask HiCode to build, inspect, or fix something");
        expect(instance.lastFrame()).not.toContain("Starting HiCode");
        expect(instance.lastFrame()).not.toContain("Input will be ready shortly");
      } finally {
        release();
        instance.unmount();
        await shutdown.close();
      }
    });
  });

  test.each(["ctrl-c", "unmount"])("MCP 授权页 %s 先取消 Root，再返回非持久跳过", async action => {
    await withTempProject(async (cwd, storage) => {
      const resources = createTestRuntimeResources(cwd);
      const shutdown = new InteractiveShutdown();
      let resolveDecision!: (value: {decision: McpApprovalDecision | undefined; aborted: boolean}) => void;
      const decision = new Promise<{decision: McpApprovalDecision | undefined; aborted: boolean}>(resolve => {resolveDecision = resolve;});
      const RuntimeBootstrap = createRuntimeBootstrap({createResources: async options => {
        const value = await options.requestMcpApproval?.({
          projectPath: cwd, serverName: "fixture", command: "bun", args: ["server.ts"], configHash: "cancel",
        });
        resolveDecision({decision: value, aborted: options.signal?.aborted === true});
        return resources;
      }});
      const instance = render(<RuntimeBootstrap shutdown={shutdown}
        configuration={createTestRootConfiguration(cwd, createTestSettings(), storage)}/>);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("◆ MCP CONNECTION");
      if (action === "ctrl-c") instance.stdin.write("\u0003");
      else instance.unmount();
      expect(await decision).toEqual({decision: "skip", aborted: true});
      await shutdown.close();
    });
  });

  test("运行中 MCP 重新授权保留 App 和 Session，Esc 只跳过本次", async () => {
    await withTempProject(async (cwd, storage) => {
      const resources = createTestRuntimeResources(cwd);
      let sessionEnds = 0;
      resources.hooks.execute = async input => {
        if (input.hook_event_name === "SessionEnd") sessionEnds++;
        return {blocked: false, additionalContexts: [], executions: []};
      };
      let requestApproval!: (request: McpApprovalRequest) => Promise<McpApprovalDecision>;
      const RuntimeBootstrap = createRuntimeBootstrap({createResources: async options => {
        requestApproval = options.requestMcpApproval!;
        return resources;
      }});
      const instance = render(<RuntimeBootstrap shutdown={new InteractiveShutdown()}
        configuration={createTestRootConfiguration(cwd, createTestSettings(), storage)}/>);
      await new Promise(resolve => setTimeout(resolve, 40));
      const approval = requestApproval({projectPath: cwd, serverName: "fixture", command: "bun", args: [], configHash: "review"});
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(instance.lastFrame()).toContain("◆ MCP CONNECTION");
      expect(sessionEnds).toBe(0);
      instance.stdin.write("\u001b");
      expect(await approval).toBe("skip");
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(instance.lastFrame()).not.toContain("◆ MCP CONNECTION");
      expect(sessionEnds).toBe(0);
      instance.unmount();
    });
  });

  test("运行中重新批准 Hook 保留 App 和 Session，不触发 SessionEnd", async () => {
    await withTempProject(async (cwd, storage) => {
      const resources = createTestRuntimeResources(cwd);
      let sessionEnds = 0;
      resources.hooks.execute = async input => {
        if (input.hook_event_name === "SessionEnd") sessionEnds++;
        return {blocked: false, additionalContexts: [], executions: []};
      };
      let requestTrust: ((request: HookTrustRequest) => Promise<HookTrustDecision>) | undefined;
      const RuntimeBootstrap = createRuntimeBootstrap({createResources: async options => {
        requestTrust = options.requestHookTrust;
        return resources;
      }});
      const instance = render(<RuntimeBootstrap shutdown={new InteractiveShutdown()} configuration={createTestRootConfiguration(cwd, createTestSettings(), storage)}/>);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(instance.lastFrame()).toContain("❯");
      const approval = requestTrust!({projectPath: cwd, hooks: [{event: "Stop", hookId: "a".repeat(64),
        purpose: "control", type: "command", command: "review", source: "project", path: `${cwd}/.hicode/settings.json`}]});
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(instance.lastFrame()).toContain("Stop · command: review");
      expect(sessionEnds).toBe(0);
      instance.stdin.write("1");
      expect(await approval).toBe("once");
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(instance.lastFrame()).toContain("❯");
      expect(sessionEnds).toBe(0);
      instance.unmount();
    });
  });
  test("把 MCP approval callback 映射到对话框后进入 App", async () => {
    await withTempProject(async (cwd, storage) => {
      const resources = createTestRuntimeResources(cwd);
      let decision: string | undefined;
      const RuntimeBootstrap = createRuntimeBootstrap({
        createResources: async (options) => {
          decision = await options.requestMcpApproval?.({
            projectPath: cwd,
            serverName: "fixture",
            command: "bun",
            args: ["server.ts"],
            configHash: "hidden",
          });
          return resources;
        },
      });
      const instance = render(
        <RuntimeBootstrap shutdown={new InteractiveShutdown()}
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("◆ MCP CONNECTION");
      expect(instance.lastFrame()).toContain("fixture");
      instance.stdin.write("1");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(decision).toBe("once");
      expect(instance.lastFrame()).toContain("❯");
    });
  });

  test("连续 MCP 请求重置选中项和提交状态", async () => {
    await withTempProject(async (cwd, storage) => {
      const resources = createTestRuntimeResources(cwd);
      const decisions: Array<string | undefined> = [];
      const RuntimeBootstrap = createRuntimeBootstrap({createResources: async options => {
        for (const serverName of ["first-server", "second-server"]) {
          decisions.push(await options.requestMcpApproval?.({
            projectPath: cwd, serverName, command: "bun", args: ["server.ts"], configHash: serverName,
          }));
        }
        return resources;
      }});
      const instance = render(<RuntimeBootstrap shutdown={new InteractiveShutdown()}
        configuration={createTestRootConfiguration(cwd, createTestSettings(), storage)}/>);
      await new Promise(resolve => setTimeout(resolve, 30));
      instance.stdin.write("\u001b[B");
      await new Promise(resolve => setTimeout(resolve, 30));
      instance.stdin.write("\r");
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("second-server");
      expect(instance.lastFrame()).toContain("❯ 1. Connect for this session");
      instance.stdin.write("\r");
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(decisions).toEqual(["trust-tools", "once"]);
      expect(instance.lastFrame()).not.toContain("◆ MCP CONNECTION");
    });
  });

  test("resources 初始化失败显示有界错误状态", async () => {
    await withTempProject(async (cwd, storage) => {
      const RuntimeBootstrap = createRuntimeBootstrap({
        createResources: async () => {
          throw new Error("runtime fixture failed");
        },
      });
      const instance = render(
        <RuntimeBootstrap shutdown={new InteractiveShutdown()}
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("Runtime initialization failed");
      expect(instance.lastFrame()).toContain("runtime fixture failed");
    });
  });

  test("把 Hook workspace trust callback 映射到独立确认框", async () => {
    await withTempProject(async (cwd, storage) => {
      const resources = createTestRuntimeResources(cwd);
      let decision: string | undefined;
      const RuntimeBootstrap = createRuntimeBootstrap({
        createResources: async (options) => {
          decision = await options.requestHookTrust?.({
            projectPath: cwd,
            hooks: [
              {
                event: "PreToolUse", hookId: "a".repeat(64), purpose: "control",
                type: "command",
                matcher: "bash",
                command: "./hooks/check.sh",
                source: "project",
                path: `${cwd}/.hicode/settings.json`,
              },
              {
                event: "UserPromptSubmit", hookId: "b".repeat(64), purpose: "control",
                type: "prompt",
                prompt: "Reject requests for production secrets",
                source: "project",
                path: `${cwd}/.hicode/settings.json`,
              },
            ],
          });
          return resources;
        },
      });
      const instance = render(
        <RuntimeBootstrap shutdown={new InteractiveShutdown()}
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("Hooks that execute commands or call models");
      expect(instance.lastFrame()).toContain("PreToolUse · command: ./hooks/check.sh");
      expect(instance.lastFrame()).toContain(
        "UserPromptSubmit · prompt: Reject requests for production secrets"
      );
      instance.stdin.write("2");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(decision).toBe("always");
      expect(instance.lastFrame()).toContain("❯");
    });
  });

  test("unmount 关闭 bootstrap 创建的 resources 一次", async () => {
    await withTempProject(async (cwd, storage) => {
      let closeCount = 0;
      const resources = createTestRuntimeResources(cwd, {
        async close() {
          closeCount += 1;
        },
      });
      const RuntimeBootstrap = createRuntimeBootstrap({
        createResources: async (options) => {
          expect(options.configuration.cwd).toBe(cwd);
          expect(options.configuration.settings.models.primary.model).toBe("glm-test");
          return resources;
        },
      });
      const instance = render(
        <RuntimeBootstrap shutdown={new InteractiveShutdown()}
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("❯");
      instance.unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closeCount).toBe(1);
    });
  });

  test("/resume 没有其他历史会话时显示空状态并可返回当前输入", async () => {
    await withTempProject(async (cwd, storage) => {
      const resources = createTestRuntimeResources(cwd, {storage});
      const RuntimeBootstrap = createRuntimeBootstrap({
        createResources: async () => resources,
      });
      const instance = render(
        <RuntimeBootstrap shutdown={new InteractiveShutdown()}
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
          onSessionSwitch={() => {}}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      instance.stdin.write("/resume");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(instance.lastFrame()).toContain("No other previous sessions are available to resume");

      instance.stdin.write("\u001b");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instance.lastFrame()).toContain("new session");
    });
  });

  test("/resume 先关闭当前 Root resources，再交给 Root 切换已验证的 Session", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "older-session",
        history: [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "恢复这段历史"},
          {role: "assistant", content: "历史回答"},
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      });
      const order: string[] = [];
      let switched: LoadedSession | undefined;
      let resourceGeneration = 0;
      const settings = createTestSettings();
      const RuntimeBootstrap = createRuntimeBootstrap({
        createResources: async () => {
          resourceGeneration += 1;
          const generation = resourceGeneration;
          return createTestRuntimeResources(cwd, {
            storage,
            async close() {
              order.push(`close-${generation}`);
            },
          });
        },
      });
      function SwitchHarness() {
        const [session, setSession] = useState<LoadedSession>();
        return (
          <RuntimeBootstrap shutdown={new InteractiveShutdown()}
            configuration={createTestRootConfiguration(
              cwd,
              settings,
              storage
            )}
            session={session}
            onSessionSwitch={(nextSession) => {
              order.push("switch");
              switched = nextSession;
              setSession(nextSession);
            }}
          />
        );
      }
      const instance = render(
        <SwitchHarness/>
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      instance.stdin.write("/resume");
      await new Promise((resolve) => setTimeout(resolve, 10));
      instance.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(instance.lastFrame()).toContain("Resume  Previous sessions");
      expect(instance.lastFrame()).toContain("恢复这段历史");

      instance.stdin.write("\r");
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(switched?.sessionId).toBe("older-session");
      expect(order).toEqual(["close-1", "switch"]);
      expect(resourceGeneration).toBe(2);
      expect(instance.lastFrame()).toContain("历史回答");
    });
  });

  test("初始化晚于 unmount 时立即关闭迟到 resources", async () => {
    await withTempProject(async (cwd, storage) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let closeCount = 0;
      const resources = createTestRuntimeResources(cwd, {
        async close() {
          closeCount += 1;
        },
      });
      const RuntimeBootstrap = createRuntimeBootstrap({
        createResources: async () => {
          await gate;
          return resources;
        },
      });
      const instance = render(
        <RuntimeBootstrap shutdown={new InteractiveShutdown()}
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instance.lastFrame()).toContain("Starting HiCode…");
      expect(instance.lastFrame()).not.toContain("❯ Starting HiCode");
      instance.unmount();
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closeCount).toBe(1);
    });
  });
});

test.each(["connected", "failed"] as const)("MCP startup %s uses a separate status line and keeps failures until recovery", async status => {
  await withTempProject(async (cwd, storage) => {
    let servers: McpServerSnapshot[] = [{name: "blender", source: "project", status: "connecting", toolCount: 0}];
    const listeners = new Set<() => void>();
    const manager: McpManagerLike = {
      async initialize() {}, async closeAll() {}, async reconnect() {}, async setToolPolicy() {},
      getSnapshots: () => servers, getTools: () => [],
      subscribe(listener) {listeners.add(listener); return () => {listeners.delete(listener);};},
    };
    let publish: ((servers: readonly McpServerSnapshot[]) => void) | undefined;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    const resources = createTestRuntimeResources(cwd, {mcpManager: manager});
    const shutdown = new InteractiveShutdown();
    const RuntimeBootstrap = createRuntimeBootstrap({createResources: async options => {
      publish = options.onMcpStartup; publish?.(servers); await gate; return resources;
    }});
    const view = render(<RuntimeBootstrap shutdown={shutdown} configuration={createTestRootConfiguration(cwd, createTestSettings(), storage)}/>);
    Object.defineProperty(view.stdout, "columns", {configurable: true, value: 180});
    view.stdout.emit("resize");
    const tick = () => new Promise(resolve => setTimeout(resolve, 40));
    try {
      await tick(); const loading = view.lastFrame()!;
      expect(loading).toContain("Connecting MCP · 0/1 ready · blender");
      expect(loading.indexOf("Connecting MCP")).toBeLessThan(loading.indexOf("❯ Ask HiCode"));
      expect(loading).not.toContain("❯ Connecting");
      await tick(); expect(view.lastFrame()).toContain("Connecting MCP · 0/1 ready · blender");
      servers = [{...servers[0]!, status, toolCount: status === "connected" ? 2 : 0}]; publish?.(servers); await tick();
      expect(view.lastFrame()).not.toContain("Connecting MCP");
      if (status === "failed") expect(view.lastFrame()).toContain("MCP failed · blender · /mcp for details");
      else expect(view.lastFrame()).not.toContain("MCP failed");
      release(); await tick(); await tick();
      if (status === "failed") expect(view.lastFrame()).toContain("MCP failed · blender");
      view.stdin.write("draft stays"); await tick();
      servers = [{...servers[0]!, status: "connected", toolCount: 2}]; listeners.forEach(listener => listener()); await tick();
      expect(view.lastFrame()).not.toContain("MCP failed"); expect(view.lastFrame()).not.toContain("Connecting MCP");
      expect(view.lastFrame()).toContain("draft stays");
      expect(view.lastFrame()).toContain("MCP 1/1");
    } finally {release(); view.unmount(); await shutdown.close(); await tick();}
    expect(listeners.size).toBe(0);
  });
});
