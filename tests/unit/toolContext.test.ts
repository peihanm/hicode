import {ContextUsageTracker} from "../../src/context/usage.js";
import {createFileStateTracker} from "../../src/tools/shared/fileState.js";
import {FileCommitCoordinator} from "../../src/tools/shared/fileCommit.js";
import { describe, expect, test } from "bun:test";
import { createCompactState } from "../../src/context/index.js";
import type {
  PermissionMode,
  PermissionPromptPolicy,
  PermissionRules,
} from "../../src/permissions/index.js";
import type {CollaborationMode} from "../../src/collaboration/index.js";
import { createToolContext } from "../../src/runtime/toolContext.js";
import { createTestToolResultStore } from "../helpers/toolResultStore.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createDisabledSandboxRuntime } from "../../src/sandbox/index.js";
import { createShellRunner } from "../../src/tools/bash/shellRunner.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

describe("ToolContext builder", () => {
  test("同一个 context 通过 host getters 读取最新权限状态", async () => {
    await withTempProject(async (cwd, storage) => {
      let rules: PermissionRules = { allow: [], ask: [], deny: [] };
      let mode: PermissionMode = "default";
      let collaborationMode: CollaborationMode = "build";
      let promptPolicy: PermissionPromptPolicy = "onRequest";
      const context = createToolContext({
        signal: new AbortController().signal,
        resources: {fileCommits: new FileCommitCoordinator(),
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
        session: {fileState: createFileStateTracker(),
          sessionId: "session-live",
          compactState: createCompactState(), contextUsage: new ContextUsageTracker(),
          toolResultStore: createTestToolResultStore(cwd, "session-live", {
            pillarHome: `${cwd}/results`,
          }),
        },
        host: {
          canUseTool: async () => ({ behavior: "allow" }),
          getPermissionRules: () => rules,
          getPermissionMode: () => mode,
          getCollaborationMode: () => collaborationMode,
          getPermissionPromptPolicy: () => promptPolicy,
          setPermissionMode: (next) => {
            mode = next;
          },
          setCollaborationMode: (next) => {
            collaborationMode = next;
          },
          setTodos() {},
        },
      });

      expect(context.permissionRules.allow).toEqual([]);
      expect(context.permissionMode).toBe("default");
      expect(context.collaborationMode).toBe("build");
      expect(context.permissionPromptPolicy).toBe("onRequest");

      rules = {
        allow: [{ toolName: "write_file", source: "local" }],
        ask: [],
        deny: [],
      };
      mode = "readOnly";
      collaborationMode = "plan";
      promptPolicy = "never";

      expect(context.permissionRules.allow).toEqual([
        { toolName: "write_file", source: "local" },
      ]);
      expect(context.permissionMode).toBe("readOnly");
      expect(context.collaborationMode).toBe("plan");
      expect(context.permissionPromptPolicy).toBe("never");
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
        filePath: `${cwd}/SKILL.md`,
      }];
      const compactState = createCompactState();
      const toolResultStore = createTestToolResultStore(cwd, "shared-session", {
        pillarHome: `${cwd}/results`,
      });
      const resources = {
        fileCommits: new FileCommitCoordinator(),
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
        fileState: createFileStateTracker(),
        sessionId: "shared-session",
        compactState,
        contextUsage: new ContextUsageTracker(),
        toolResultStore,
      };
      const host = {
        canUseTool: async () => ({ behavior: "allow" as const }),
        getPermissionRules: () => ({ allow: [], ask: [], deny: [] }),
        getPermissionMode: () => "default" as const,
        getCollaborationMode: () => "build" as const,
        getPermissionPromptPolicy: () => "onRequest" as const,
        setPermissionMode() {},
        setCollaborationMode() {},
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
      expect(contextA.fileState).toBe(session.fileState);
      expect(contextB.fileState).toBe(contextA.fileState);
      expect(contextA.fileCommits).toBe(contextB.fileCommits);
      expect(contextA).not.toBe(contextB);
    });
  });
});
