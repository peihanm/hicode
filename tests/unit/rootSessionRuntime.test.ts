import {describe, expect, test} from "bun:test";
import {createCompactState} from "../../src/context/index.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import type {HookRuntime} from "../../src/hooks/index.js";
import type {PermissionMode} from "../../src/permissions/index.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";

describe("RootSessionRuntime", () => {
  test("统一拥有 Session 资源、Context、Snapshot 和 Hook 协议", async () => {
    await withTempProject(async (cwd) => {
      const hookEvents: string[] = [];
      const hookSessions: unknown[] = [];
      const hooks: HookRuntime = {
        enabled: true,
        issues: [],
        async execute(input, _signal, context) {
          hookEvents.push(input.hook_event_name);
          hookSessions.push(context?.session);
          return {
            blocked: false,
            additionalContexts: [],
            executions: [],
          };
        },
      };
      const resources = createTestRuntimeResources(cwd, {hooks});
      const initialCompactState = createCompactState();
      const runtime = createRootSessionRuntime({
        resources,
        seed: {
          sessionId: "session-runtime-test",
          history: [{role: "system", content: "system"}],
          compactState: initialCompactState,
          toolDiscovery: {
            version: 1,
            discoveredNames: ["web_fetch"],
          },
          queuedInputs: [{
            id: "queued-1",
            type: "user_input",
            priority: "later",
            content: "继续处理",
            createdAt: "2026-07-22T00:00:00.000Z",
          }],
        },
        resumed: true,
      });

      await Promise.all([runtime.initialize(), runtime.initialize()]);
      expect(resources.toolRuntime.getToolSchemas().some(
        (tool) => tool.function.name === "web_fetch"
      )).toBe(true);
      expect(runtime.taskSession.sessionId).toBe("session-runtime-test");

      let permissionMode: PermissionMode = "default";
      const ctx = runtime.createContext({
        signal: new AbortController().signal,
        onEvent: () => {},
        host: {
          canUseTool: async () => ({
            behavior: "deny",
            message: "test deny",
          }),
          getPermissionRules: () => ({allow: [], ask: [], deny: []}),
          getPermissionMode: () => permissionMode,
          getCollaborationMode: () => "build",
          getPermissionPromptPolicy: () => "onRequest",
          setPermissionMode(mode) {
            permissionMode = mode;
          },
          setCollaborationMode() {},
          setTodos: () => {},
        },
      });
      expect(ctx.tasks).toBe(runtime.taskSession);
      expect(ctx.gitSession).toBe(runtime.gitSession);
      expect(ctx.fileCheckpoints).toBe(runtime.fileCheckpoints);
      expect(ctx.subagentLauncher).toBeDefined();
      expect(ctx.hookSession).toBeDefined();

      const nextCompactState = createCompactState();
      runtime.replaceConversation(
        [
          {role: "system", content: "system"},
          {role: "user", content: "new turn"},
        ],
        nextCompactState
      );
      const snapshot = runtime.createSnapshot({
        todos: [],
        permissionMode: "default",
        collaborationMode: "build",
        uiEvents: [],
      });
      expect(snapshot.history.at(-1)?.content).toBe("new turn");
      expect(snapshot.compactState).toEqual(nextCompactState);
      expect(snapshot.queuedInputs).toHaveLength(1);
      expect(snapshot.toolDiscovery?.discoveredNames).toContain("web_fetch");

      const signal = new AbortController().signal;
      await runtime.runSessionStart("resume", signal);
      await runtime.runUserPromptHooks("继续", "default", signal);
      await runtime.runSessionEnd("completed");
      expect(hookEvents).toEqual([
        "SessionStart",
        "UserPromptSubmit",
        "SessionEnd",
      ]);
      expect(hookSessions).toEqual([
        ctx.hookSession,
        ctx.hookSession,
        ctx.hookSession,
      ]);

      await resources.close();
    });
  });
});
