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
import {saveSessionSnapshot, type LoadedSession} from "../../src/session/index.js";

afterEach(() => cleanup());

describe("RuntimeBootstrap lifecycle", () => {
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
        <RuntimeBootstrap
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("项目请求启动 MCP Server：fixture");
      instance.stdin.write("1");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(decision).toBe("once");
      expect(instance.lastFrame()).toContain("❯");
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
        <RuntimeBootstrap
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("Runtime 初始化失败");
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
                event: "PreToolUse",
                type: "command",
                matcher: "bash",
                command: "./hooks/check.sh",
                source: "project",
                path: `${cwd}/.pillar/settings.json`,
              },
              {
                event: "UserPromptSubmit",
                type: "prompt",
                prompt: "Reject requests for production secrets",
                source: "project",
                path: `${cwd}/.pillar/settings.json`,
              },
            ],
          });
          return resources;
        },
      });
      const instance = render(
        <RuntimeBootstrap
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("会执行命令或调用模型的 Hooks");
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
        <RuntimeBootstrap
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
        <RuntimeBootstrap
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
      expect(instance.lastFrame()).toContain("没有其他可恢复的历史会话");

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
          {role: "user", content: "恢复这段历史"},
          {role: "assistant", content: "历史回答"},
        ],
        todos: [],
        permissionMode: "default",
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
          <RuntimeBootstrap
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
      expect(instance.lastFrame()).toContain("Resume  恢复历史会话");
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
        <RuntimeBootstrap
          configuration={createTestRootConfiguration(
            cwd,
            createTestSettings(),
            storage
          )}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(instance.lastFrame()).toContain("正在初始化运行时");
      instance.unmount();
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closeCount).toBe(1);
    });
  });
});
