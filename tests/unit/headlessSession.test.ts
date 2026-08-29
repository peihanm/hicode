import { describe, expect, test } from "bun:test";
import { createCompactState } from "../../src/context/index.js";
import { loadHeadlessSession } from "../../src/headless/session.js";
import { saveSessionSnapshot } from "../../src/session/index.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTestSettings } from "../helpers/runtimeResources.js";

describe("headless session boundary", () => {
  test("none 创建默认 state 且使用 CLI permission override", async () => {
    await withTempProject(async (cwd, storage) => {
      const state = loadHeadlessSession({ storage,
        cwd,
        settings: createTestSettings(),
        resumeMode: { kind: "none" },
        permissionMode: "dontAsk",
      });
      expect(state.permissionMode).toBe("dontAsk");
      expect(state.history[0]?.role).toBe("system");
      expect(state.todos).toEqual([]);
    });
  });

  test("没有 CLI 或 Session mode 时使用同一 Settings snapshot", async () => {
    await withTempProject(async (cwd, storage) => {
      const state = loadHeadlessSession({ storage,
        cwd,
        settings: createTestSettings({
          permissions: {
            defaultMode: "dontAsk",
            rules: { allow: [], ask: [], deny: [] },
          },
        }),
        resumeMode: { kind: "none" },
      });
      expect(state.permissionMode).toBe("dontAsk");
    });
  });

  test("picker、missing continue 和 missing id 保持错误", async () => {
    await withTempProject(async (cwd, storage) => {
      expect(() =>
        loadHeadlessSession({ storage,
          cwd,
          settings: createTestSettings(),
          resumeMode: { kind: "picker" },
        })
      ).toThrow("headless 模式不能使用交互式 -r");
      expect(() =>
        loadHeadlessSession({ storage,
          cwd,
          settings: createTestSettings(),
          resumeMode: { kind: "continue" },
        })
      ).toThrow("没有找到可继续的历史会话");
      expect(() =>
        loadHeadlessSession({ storage,
          cwd,
          settings: createTestSettings(),
          resumeMode: { kind: "session", sessionId: "missing" },
        })
      ).toThrow("没有找到会话: missing");
    });
  });

  test("resume mode 恢复，CLI mode 优先于 snapshot mode", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "session-1",
        history: [
          { role: "system", content: "system" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" },
        ],
        todos: [],
        permissionMode: "acceptEdits",
        compactState: createCompactState(),
        uiEvents: [],
        toolDiscovery: {
          version: 1,
          discoveredNames: ["mcp__fixture__echo"],
        },
      });
      const resumed = loadHeadlessSession({ storage,
          cwd,
          settings: createTestSettings(),
          resumeMode: { kind: "continue" },
        });
      expect(resumed.permissionMode).toBe("acceptEdits");
      expect(resumed.toolDiscovery).toEqual({
        version: 1,
        discoveredNames: ["mcp__fixture__echo"],
      });
      expect(
        loadHeadlessSession({ storage,
          cwd,
          settings: createTestSettings(),
          resumeMode: { kind: "session", sessionId: "session-1" },
          permissionMode: "bypassPermissions",
        }).permissionMode
      ).toBe("bypassPermissions");
    });
  });
});
