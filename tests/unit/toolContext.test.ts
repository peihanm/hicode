import { describe, expect, test } from "bun:test";
import { createCompactState } from "../../src/context/index.js";
import type {
  PermissionMode,
  PermissionRules,
} from "../../src/permissions/index.js";
import { createToolContext } from "../../src/runtime/toolContext.js";
import { createTestToolResultStore } from "../helpers/toolResultStore.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createDisabledFileCheckpointRuntime } from "../../src/checkpoints/index.js";
import { createDisabledSandboxRuntime } from "../../src/sandbox/index.js";
import { createShellRunner } from "../../src/tools/bash/shellRunner.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

describe("ToolContext builder", () => {
  test("同一个 context 通过 host getters 读取最新权限状态", async () => {
    await withTempProject(async (cwd, storage) => {
      let rules: PermissionRules = { allow: [], ask: [], deny: [] };
      let mode: PermissionMode = "default";
      let prePlanMode: PermissionMode | undefined;
      const context = createToolContext({
        signal: new AbortController().signal,
        resources: {
          storage,
          cwd,
          model: "glm-test",
          provider: "glm",
          fastModel: "glm-fast-test",
          fastProvider: "glm",
          skills: [],
          shellRunner: createShellRunner(
            createDisabledSandboxRuntime(),
            testChildEnvironment,
          ),
        },
        session: {
          sessionId: "session-live",
          compactState: createCompactState(),
          toolResultStore: createTestToolResultStore(cwd, "session-live", {
            pillarHome: `${cwd}/results`,
          }),
          fileCheckpoints: createDisabledFileCheckpointRuntime(),
        },
        host: {
          canUseTool: async () => ({ behavior: "allow" }),
          getPermissionRules: () => rules,
          getPermissionMode: () => mode,
          getPrePlanMode: () => prePlanMode,
          setPermissionMode: (next) => {
            mode = next;
          },
          setTodos() {},
        },
      });

      expect(context.permissionRules.allow).toEqual([]);
      expect(context.permissionMode).toBe("default");
      expect(context.prePlanMode).toBeUndefined();

      rules = {
        allow: [{ toolName: "write_file", source: "local" }],
        ask: [],
        deny: [],
      };
      mode = "plan";
      prePlanMode = "acceptEdits";

      expect(context.permissionRules.allow).toEqual([
        { toolName: "write_file", source: "local" },
      ]);
      expect(context.permissionMode).toBe("plan");
      expect(context.prePlanMode).toBe("acceptEdits");
    });
  });

  test("每次构造保留独立 signal，同时复用稳定 resources/session", async () => {
    await withTempProject(async (cwd, storage) => {
      const controllerA = new AbortController();
      const controllerB = new AbortController();
      const skills = [{
        name: "test-skill",
        description: "test",
        whenToUse: "test",
        content: "test",
        source: "project" as const,
        path: `${cwd}/SKILL.md`,
        baseDir: cwd,
      }];
      const compactState = createCompactState();
      const toolResultStore = createTestToolResultStore(cwd, "shared-session", {
        pillarHome: `${cwd}/results`,
      });
      const resources = {
        storage,
        cwd,
        model: "glm-test",
        provider: "glm" as const,
        fastModel: "glm-fast-test",
        fastProvider: "glm" as const,
        skills,
        shellRunner: createShellRunner(
          createDisabledSandboxRuntime(),
          testChildEnvironment,
        ),
      };
      const session = {
        sessionId: "shared-session",
        compactState,
        toolResultStore,
        fileCheckpoints: createDisabledFileCheckpointRuntime(),
      };
      const host = {
        canUseTool: async () => ({ behavior: "allow" as const }),
        getPermissionRules: () => ({ allow: [], ask: [], deny: [] }),
        getPermissionMode: () => "default" as const,
        getPrePlanMode: () => undefined,
        setPermissionMode() {},
        setTodos() {},
      };

      const contextA = createToolContext({
        signal: controllerA.signal,
        resources,
        session,
        host,
      });
      const contextB = createToolContext({
        signal: controllerB.signal,
        resources,
        session,
        host,
      });

      controllerA.abort("user-cancel");
      expect(contextA.signal.aborted).toBe(true);
      expect(contextB.signal.aborted).toBe(false);
      expect(contextA.skills).toBe(skills);
      expect(contextB.compactState).toBe(compactState);
      expect(contextA.toolResultStore).toBe(toolResultStore);
      expect(contextA).not.toBe(contextB);
    });
  });
});
