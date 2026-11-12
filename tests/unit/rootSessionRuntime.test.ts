import {describe, expect, test, spyOn} from "bun:test";
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
          queuedInputs: [{
            id: "queued-1",
            type: "user_input",
            priority: "later",
            content: "继续处理",
            createdAt: "2026-07-22T00:00:00.000Z",
          }],
        },

      });

      await Promise.all([runtime.initialize(), runtime.initialize()]);
      expect(resources.toolRuntime.getToolSchemas().some(
        (tool) => tool.function.name === "web_fetch"
      )).toBe(true);
      expect(runtime.taskSession.sessionId).toBe("session-runtime-test");

      let permissionMode: PermissionMode = "ask";
      const ctx = runtime.createContext({getSnapshotState: () => ({todos: [], uiEvents: [], permissionMode: "ask", }),
        signal: new AbortController().signal,
        onEvent: () => {},
        host: {
          canUseTool: async () => ({
            behavior: "deny",
            message: "test deny",
          }),
          getPermissionRules: () => ({allow: [], ask: [], deny: []}),
          getPermissionMode: () => permissionMode,
          getPermissionPromptPolicy: () => "onRequest",
          setTodos: () => {},
        },
      });
      expect(ctx.tasks).toBe(runtime.taskSession);
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

        uiEvents: [],
      });
      expect(snapshot.history.at(-1)?.content).toBe("new turn");
      expect(snapshot.compactState).toEqual(nextCompactState);
      expect(snapshot.queuedInputs).toHaveLength(1);
      expect(snapshot).not.toHaveProperty("toolDiscovery");

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


test("Root context reads only execution capabilities, freezes its model and keeps the tool catalog live", async () => {
    await withTempProject(async cwd => {
        const resources = createTestRuntimeResources(cwd);
        let model = "first-model";
        Object.defineProperty(resources, "model", {enumerable: true, get: () => model});
        Object.defineProperty(resources, "modelConfiguration", {enumerable: true, get() {
            throw new Error("Root configuration must not be read to build tool context");
        }});
        let tools = resources.toolRuntime.getTools();
        const catalog = spyOn(resources.toolRuntime, "getTools").mockImplementation(() => tools);
        const runtime = createRootSessionRuntime({resources, seed: {
            sessionId: "explicit-capabilities", history: [{role: "system", content: "test"}], compactState: createCompactState(),
        }});
        const contextInput = {
            signal: new AbortController().signal, onEvent() {},
            getSnapshotState: () => ({todos: [], uiEvents: [], permissionMode: "ask" as const}),
            host: {canUseTool: async () => ({behavior: "deny" as const, message: "test"}), setTodos() {},
                getPermissionMode: () => "ask" as const, getPermissionPromptPolicy: () => "never" as const,
                getPermissionRules: runtime.permissions.getRules},
        };
        try {
            const current = runtime.createContext(contextInput);
            expect(current.model).toBe("first-model");
            expect(current.tasks).toBe(runtime.taskSession);
            expect(current.availableTools.length).toBeGreaterThan(0);
            model = "second-model";
            tools = [];
            expect(current.model).toBe("first-model");
            expect(current.availableTools).toEqual([]);
            const next = runtime.createContext(contextInput);
            expect(next.model).toBe("second-model");
            expect(next.tasks).toBe(current.tasks);
            expect(next.taskJoin).not.toBe(current.taskJoin);
        } finally {
            catalog.mockRestore();
            await runtime.runSessionEnd("test");
            await resources.close();
        }
    });
});
