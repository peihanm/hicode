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
        enabled: true, hasToolHooks: () => true, inspect: () => [], reload: async () => {},
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
            version: 2,
            loadedNames: ["missing_tool"],
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

      let permissionMode: PermissionMode = "ask";
      const ctx = runtime.createContext({getSnapshotState: () => ({todos: [], uiEvents: [], permissionMode: "ask", collaborationMode: "build"}),
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
          setTodos: () => {},
        },
      });
      expect(ctx.tasks).toBe(runtime.taskSession);
      expect(ctx.gitSession).toBe(runtime.gitSession);
      expect(ctx.subagentLauncher).toBeDefined();
      expect(ctx.hookSession).toBeDefined();

      const nextCompactState = createCompactState();
      runtime.replaceConversation(
        [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "new turn"},
        ],
        nextCompactState
      );
      const snapshot = runtime.createSnapshot({
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
        uiEvents: [],
      });
      expect(snapshot.history.at(-1)?.content).toBe("new turn");
      expect(snapshot.compactState).toEqual(nextCompactState);
      expect(snapshot.queuedInputs).toHaveLength(1);
      expect(snapshot.toolDiscovery?.loadedNames).toEqual([]);

      const signal = new AbortController().signal;
      await runtime.runSessionStart("resume", signal);
      await ctx.runHook!({hook_event_name: "UserPromptSubmit", session_id: runtime.sessionId, prompt: "继续", permission_mode: "default"});
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
