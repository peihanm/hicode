import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import { describe, expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  readFile,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import {dirname, join} from "node:path";
import { createCompactState } from "../../src/context/index.js";
import {listSessionIndex, loadLatestSession, loadSession} from "../../src/session/index.js";
import type { Message } from "../../src/llm/types.js";
import { createFileChange } from "../../src/fileChanges/index.js";
import { withTempProject } from "../helpers/tempProject.js";
import {getSessionIndexPath, getSessionSnapshotPath} from "../../src/session/paths.js";
import {getProjectSessionsDirectory} from "../../src/persistence/index.js";

describe("session persistence", () => {
  test("保存并恢复尚未消费的运行中消息", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "queued-session",
        history: [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "原始任务"},
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
        taskNotificationReceipts: ["a".repeat(64)],
        queuedInputs: [{
          id: "queued-1",
          type: "user_input",
          priority: "later",
          content: "恢复后继续",
          createdAt: "2026-07-20T00:00:00.000Z",
        }],
      });

      expect(loadSession(storage, cwd, "queued-session", "glm-test")?.taskNotificationReceipts).toEqual(["a".repeat(64)]);
      expect(loadSession(storage, cwd, "queued-session", "glm-test")?.queuedInputs)
        .toEqual([{
          id: "queued-1",
          type: "user_input",
          priority: "later",
          content: "恢复后继续",
          createdAt: "2026-07-20T00:00:00.000Z",
        }]);
    });
  });

  test("保存 snapshot、建立索引并恢复最新对话", async () => {
    await withTempProject(async (cwd, storage) => {
      const history: Message[] = [
        { role: "system", content: "不会持久化" },
        { role: "user", origin: "user" as const, content: "第一个任务" },
        { role: "assistant", content: "Completed" },
      ];
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "session-1",
        history,
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
        compactState: createCompactState(),
        toolDiscovery: {
          version: 2,
          loadedNames: ["mcp__fixture__echo"],
        },
      });

      const index = listSessionIndex(storage, cwd);
      expect(index).toHaveLength(1);
      expect(index[0]).toMatchObject({
        sessionId: "session-1",
        messageCount: 2,
      });

      const loaded = loadSession(storage, cwd, "session-1", "glm-test");
      expect(loaded?.history[0]?.role).toBe("system");
      expect(loaded?.history.filter((message) => message.role === "system")).toHaveLength(1);
      expect(loaded?.history.slice(-2)).toEqual(history.slice(-2));
      expect(loaded?.toolDiscovery).toEqual({
        version: 2,
        loadedNames: ["mcp__fixture__echo"],
      });
      const snapshot = JSON.parse(
        await readFile(
          getSessionSnapshotPath(storage, cwd, "session-1"),
          "utf8"
        )
      );
      expect(snapshot.version).toBe(8);
      expect((await stat(getSessionIndexPath(storage, cwd))).mode & 0o777).toBe(0o600);
      expect((await stat(getSessionSnapshotPath(storage, cwd, "session-1"))).mode & 0o777)
        .toBe(0o600);
      expect((await stat(dirname(
        getSessionSnapshotPath(storage, cwd, "session-1")
      ))).mode & 0o777).toBe(0o700);
      expect(loadLatestSession(storage, cwd, "glm-test")?.sessionId).toBe("session-1");
    });
  });

  test("旧 Tool Discovery 状态被丢弃但不会阻止恢复对话", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "legacy-tool-discovery",
        history: [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "继续之前的对话"},
          {role: "assistant", content: "可以继续"},
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      });
      const path = getSessionSnapshotPath(storage, cwd, "legacy-tool-discovery");
      const snapshot = JSON.parse(await readFile(path, "utf8"));
      snapshot.toolDiscovery = {
        version: 1,
        discoveredNames: ["mcp__legacy__tool"],
      };
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");

      const loaded = loadSession(
        storage,
        cwd,
        "legacy-tool-discovery",
        "glm-test"
      );
      expect(loaded?.history.at(-1)?.content).toBe("可以继续");
      expect(loaded?.toolDiscovery).toBeUndefined();
    });
  });

  test("不读取旧版或缺少版本的 snapshot，列表只使用索引", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "unversioned",
        history: [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "旧对话"},
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      });
      const path = getSessionSnapshotPath(storage, cwd, "unversioned");
      const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      snapshot.version = 3;
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
      expect(() => loadSession(storage, cwd, "unversioned", "glm-test")).toThrow();
      snapshot.version = 2;
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
      expect(() => loadSession(storage, cwd, "unversioned", "glm-test")).toThrow();

      snapshot.version = 1;
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
      expect(() => loadSession(storage, cwd, "unversioned", "glm-test")).toThrow();

      delete snapshot.version;
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");

      expect(() => loadSession(storage, cwd, "unversioned", "glm-test")).toThrow();
      expect(listSessionIndex(storage, cwd).map(entry => entry.sessionId)).toEqual(["unversioned"]);
    });
  });

  test("a malformed snapshot reports corruption instead of pretending the session is absent", async () => {
    await withTempProject(async (cwd, storage) => {
      const path = getSessionSnapshotPath(storage, cwd, "broken");
      await mkdir(dirname(path), {recursive: true});
      await writeFile(path, "{partial-json");
      expect(() => loadSession(storage, cwd, "broken", "glm-test")).toThrow("Invalid Session snapshot JSON");
    });
  });

  test("不恢复身份不匹配或工具调用未配对的 snapshot", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "untrusted-session",
        history: [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "原始任务"},
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      });
      const path = getSessionSnapshotPath(storage, cwd, "untrusted-session");
      const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;

      snapshot.cwd = `${cwd}-other`;
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
      expect(() => loadSession(storage, cwd, "untrusted-session", "glm-test")).toThrow();
      expect(listSessionIndex(storage, cwd).map(entry => entry.sessionId)).toEqual(["untrusted-session"]);

      snapshot.cwd = cwd;
      snapshot.conversation = [{
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "dangling-call",
          type: "function",
          function: {name: "read_file", arguments: "{}"},
        }],
      }];
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
      expect(() => loadSession(storage, cwd, "untrusted-session", "glm-test")).toThrow();
    });
  });

  test("保存时拒绝完整坏行并跳过执行中的不完整消息链", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "strict-mutation",
        history: [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "保留"},
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      });
      const path = getSessionSnapshotPath(storage, cwd, "strict-mutation");
      await appendFile(path, "{}\n");
      const before = await readFile(path, "utf8");

      await expect(saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "strict-mutation",
        history: [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "下一次"},
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      })).rejects.toThrow("Invalid Session snapshot JSON");
      expect(await readFile(path, "utf8")).toBe(before);

      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "invalid-outgoing",
        history: [{
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "dangling-call",
            type: "function",
            function: {name: "read_file", arguments: "{}"},
          }],
        }],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
        allowEmpty: true,
        summaryHint: "invalid",
      });
      expect(loadSession(storage, cwd, "invalid-outgoing", "glm-test")).toBeNull();
      expect(listSessionIndex(storage, cwd).some(
        (entry) => entry.sessionId === "invalid-outgoing"
      )).toBe(false);
    });
  });

  test("没有真实用户输入时不创建空 session", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "empty",
        history: [{ role: "system", content: "system only" }],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      });
      expect(listSessionIndex(storage, cwd)).toEqual([]);
    });
  });

  test("结构化文件修改独立保存并恢复", async () => {
    await withTempProject(async (cwd, storage) => {
      const change = createFileChange({
        path: "src/a.ts",
        kind: "update",
        oldContent: "const a = 1;\n",
        newContent: "const a = 2;\n",
      });
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "with-ui",
        history: [
          { role: "system", content: "system" },
          { role: "user", origin: "user" as const, content: "修改 a" },
          {
            role: "assistant",
            content: null,
            reasoning: {content: "需要修改文件", scope: "a".repeat(64)},
            tool_calls: [{
              id: "edit-a",
              type: "function",
              function: { name: "edit_file", arguments: "{}" },
            }],
          },
          { role: "tool", content: "Modified", tool_call_id: "edit-a" },
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
        uiEvents: [{
          version: 1,
          type: "file_change",
          turnId: "turn-a",
          toolCallId: "edit-a",
          timestamp: "2026-07-12T00:00:00.000Z",
          change,
        }],
      });

      const loaded = loadSession(storage, cwd, "with-ui", "glm-test");
      expect(loaded?.uiEvents).toHaveLength(1);
      const restoredChange = loaded?.uiEvents.find(
        (event) => event.type === "file_change"
      );
      expect(restoredChange?.change).toMatchObject({
        path: "src/a.ts",
        linesAdded: 1,
        linesRemoved: 1,
      });
      expect(loaded?.history.at(-2)).toMatchObject({
        role: "assistant",
        reasoning: {content: "需要修改文件", scope: "a".repeat(64)},
      });
    });
  });

  test("并发保存不同 session 时 index 保留完整并集", async () => {
    await withTempProject(async (cwd, storage) => {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          saveSessionSnapshot(storage, {
            cwd,
            model: "glm-test",
            sessionId: `parallel-${index}`,
            history: [
              { role: "system", content: "system" },
              { role: "user", origin: "user" as const, content: `task-${index}` },
            ],
            todos: [],
            permissionMode: "ask",
        collaborationMode: "build",
          })
        )
      );

      expect(
        listSessionIndex(storage, cwd)
          .map((entry) => entry.sessionId)
          .sort()
      ).toEqual(
        Array.from({ length: 12 }, (_, index) => `parallel-${index}`).sort()
      );
    });
  });

  test("同一 session 并发保存时只保留最新 snapshot 且 index 可用", async () => {
    await withTempProject(async (cwd, storage) => {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          saveSessionSnapshot(storage, {
            cwd,
            model: "glm-test",
            sessionId: "shared",
            history: [
              { role: "system", content: "system" },
              { role: "user", origin: "user" as const, content: `shared-${index}` },
            ],
            todos: [],
            permissionMode: "ask",
        collaborationMode: "build",
          })
        )
      );

      const lines = (
        await readFile(getSessionSnapshotPath(storage, cwd, "shared"), "utf8")
      )
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      expect(lines.every((line) => JSON.parse(line).type === "snapshot")).toBe(true);
      expect(listSessionIndex(storage, cwd)).toHaveLength(1);
      expect(loadSession(storage, cwd, "shared", "glm-test")).not.toBeNull();
    });
  });

  test("重复保存只保留最新 snapshot", async () => {
    await withTempProject(async (cwd, storage) => {
      for (const content of ["first", "latest"]) {
        await saveSessionSnapshot(storage, {
          cwd,
          model: "glm-test",
          sessionId: "compact-log",
          history: [
            {role: "system", content: "system"},
            {role: "user", origin: "user" as const, content},
          ],
          todos: [],
          permissionMode: "ask",
        collaborationMode: "build",
        });
      }

      const lines = (await readFile(
        getSessionSnapshotPath(storage, cwd, "compact-log"),
        "utf8"
      )).trim().split("\n").map((line) => JSON.parse(line) as {type: string});
      expect(lines.map((line) => line.type)).toEqual([
        "snapshot",
      ]);
      expect(loadSession(storage, cwd, "compact-log", "glm-test")?.history.at(-1))
        .toEqual({role: "user", origin: "user" as const, content: "latest"});
    });
  });

  test("损坏 index 时拒绝覆盖，但已经追加的 snapshot 仍可按 id 恢复", async () => {
    await withTempProject(async (cwd, storage) => {
      const indexPath = getSessionIndexPath(storage, cwd);
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "existing",
        history: [
          { role: "system", content: "system" },
          { role: "user", origin: "user" as const, content: "existing" },
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      });
      await writeFile(indexPath, "{corrupt-index", "utf8");

      await expect(
        saveSessionSnapshot(storage, {
          cwd,
          model: "glm-test",
          sessionId: "after-corruption",
          history: [
            { role: "system", content: "system" },
            { role: "user", origin: "user" as const, content: "recoverable" },
          ],
          todos: [],
          permissionMode: "ask",
        collaborationMode: "build",
        })
      ).resolves.toBeUndefined();
      expect(await readFile(indexPath, "utf8")).toBe("{corrupt-index");
      expect(loadSession(storage, cwd, "after-corruption", "glm-test")?.history.at(-1)).toEqual({
        role: "user", origin: "user" as const,
        content: "recoverable",
      });
    });
  });

  test("Session 目录和持久化文件拒绝 Symlink", async () => {
    await withTempProject(async (cwd, storage) => {
      const sessionsDirectory = getProjectSessionsDirectory(storage, cwd);
      const redirectedDirectory = join(cwd, "redirected-sessions");
      await mkdir(dirname(sessionsDirectory), {recursive: true});
      await mkdir(redirectedDirectory);
      await symlink(redirectedDirectory, sessionsDirectory);

      await expect(saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "directory-symlink",
        history: [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "不得重定向"},
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      })).rejects.toThrow("Unsafe Pillar storage directory");
    });

    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "file-symlink",
        history: [
          {role: "system", content: "system"},
          {role: "user", origin: "user" as const, content: "原始内容"},
        ],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      });
      const logPath = getSessionSnapshotPath(storage, cwd, "file-symlink");
      const originalLog = await readFile(logPath, "utf8");
      const redirectedLog = join(cwd, "redirected-events.jsonl");
      await writeFile(redirectedLog, originalLog, "utf8");
      await unlink(logPath);
      await symlink(redirectedLog, logPath);

      expect(() => loadSession(storage, cwd, "file-symlink", "glm-test")).toThrow();
      await expect(saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "file-symlink",
        history: [{role: "user", origin: "user" as const, content: "继续"}],
        todos: [],
        permissionMode: "ask",
        collaborationMode: "build",
      })).rejects.toThrow();
      expect(await readFile(redirectedLog, "utf8")).toBe(originalLog);

      const indexPath = getSessionIndexPath(storage, cwd);
      const redirectedIndex = join(cwd, "redirected-index.json");
      const originalIndex = await readFile(indexPath, "utf8");
      await writeFile(redirectedIndex, originalIndex, "utf8");
      await unlink(indexPath);
      await symlink(redirectedIndex, indexPath);
      expect(() => listSessionIndex(storage, cwd)).toThrow();
      expect(await readFile(redirectedIndex, "utf8")).toBe(originalIndex);
    });
  });
});
