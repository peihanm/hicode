import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import { describe, expect, test } from "bun:test";
import { createCompactState } from "../../src/context/index.js";
import { loadHeadlessSession } from "../../src/headless/session.js";

import { withTempProject } from "../helpers/tempProject.js";
import { createTestSettings } from "../helpers/runtimeResources.js";
import {
  CLI_FILE_SOURCES,
  createPillarRootConfiguration,
} from "../../src/runtime/rootConfiguration.js";
import type {PillarStorageLayout} from "../../src/persistence/index.js";
import type {ResolvedPillarSettings} from "../../src/settings/index.js";

function configuration(
  cwd: string,
  storage: PillarStorageLayout,
  settings: ResolvedPillarSettings = createTestSettings()
) {
  return createPillarRootConfiguration({
    cwd,
    workspaceBoundary: cwd,
    storage,
    settings,
    fileSources: CLI_FILE_SOURCES,
  });
}

describe("headless session boundary", () => {
  test("none 创建默认 state 且使用 CLI permission override", async () => {
    await withTempProject(async (cwd, storage) => {
      const state = loadHeadlessSession({
        configuration: configuration(cwd, storage),
        resumeMode: { kind: "none" },
        permissionMode: "readOnly",
        collaborationMode: "build",
      });
      expect(state.permissionMode).toBe("readOnly");
      expect(state.history[0]?.role).toBe("system");
      expect(state.todos).toEqual([]);
    });
  });

  test("没有 CLI 或 Session mode 时使用同一 Settings snapshot", async () => {
    await withTempProject(async (cwd, storage) => {
      const state = loadHeadlessSession({
        configuration: configuration(cwd, storage, createTestSettings({
          permissions: {
            defaultMode: "readOnly",
            additionalDirectories: [],
            rules: { allow: [], ask: [], deny: [] },
          },
        })),
        resumeMode: { kind: "none" },
      });
      expect(state.permissionMode).toBe("readOnly");
    });
  });

  test("picker、missing continue 和 missing id 保持错误", async () => {
    await withTempProject(async (cwd, storage) => {
      expect(() =>
        loadHeadlessSession({
          configuration: configuration(cwd, storage),
          resumeMode: { kind: "picker" },
        })
      ).toThrow("headless 模式不能使用交互式 -r");
      expect(() =>
        loadHeadlessSession({
          configuration: configuration(cwd, storage),
          resumeMode: { kind: "continue" },
        })
      ).toThrow("没有找到可继续的历史会话");
      expect(() =>
        loadHeadlessSession({
          configuration: configuration(cwd, storage),
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
          { role: "user", origin: "user" as const, content: "hello" },
          { role: "assistant", content: "world" },
        ],
        todos: [],
        permissionMode: "default",
        collaborationMode: "build",
        compactState: createCompactState(),
        uiEvents: [],
        toolDiscovery: {
          version: 2,
          loadedNames: ["mcp__fixture__echo"],
        },
      });
      const resumed = loadHeadlessSession({
          configuration: configuration(cwd, storage),
          resumeMode: { kind: "continue" },
        });
      expect(resumed.permissionMode).toBe("default");
      expect(resumed.toolDiscovery).toEqual({
        version: 2,
        loadedNames: ["mcp__fixture__echo"],
      });
      expect(
        loadHeadlessSession({
          configuration: configuration(cwd, storage),
          resumeMode: { kind: "session", sessionId: "session-1" },
          permissionMode: "bypassPermissions",
        collaborationMode: "build",
        }).permissionMode
      ).toBe("bypassPermissions");
    });
  });
});
