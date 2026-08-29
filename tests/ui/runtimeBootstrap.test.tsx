import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { createRuntimeBootstrap } from "../../src/ui/bootstrap/RuntimeBootstrap.js";
import {
  createTestRuntimeResources,
  createTestSettings,
} from "../helpers/runtimeResources.js";
import { withTempProject } from "../helpers/tempProject.js";

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
          storage={storage}
          cwd={cwd}
          settings={createTestSettings()}
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
          storage={storage}
          cwd={cwd}
          settings={createTestSettings()}
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
          storage={storage}
          cwd={cwd}
          settings={createTestSettings()}
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
          expect(options.cwd).toBe(cwd);
          expect(options.settings.models.primary.model).toBe("glm-test");
          return resources;
        },
      });
      const instance = render(
        <RuntimeBootstrap
          storage={storage}
          cwd={cwd}
          settings={createTestSettings()}
        />
      );

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(instance.lastFrame()).toContain("❯");
      instance.unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closeCount).toBe(1);
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
          storage={storage}
          cwd={cwd}
          settings={createTestSettings()}
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
