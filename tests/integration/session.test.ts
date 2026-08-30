import { describe, expect, test } from "bun:test";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import {dirname} from "node:path";
import { createCompactState } from "../../src/context/index.js";
import {
  listSessionIndex,
  loadLatestSession,
  loadSession,
  listSessionTurnCheckpoints,
  loadSessionTurnCheckpoint,
  saveSessionSnapshot,
  saveSessionTurnCheckpoint,
} from "../../src/session/index.js";
import type { Message } from "../../src/llm/types.js";
import { createFileChange } from "../../src/fileChanges/index.js";
import { withTempProject } from "../helpers/tempProject.js";
import {getSessionIndexPath, getSessionLogPath} from "../../src/session/paths.js";

describe("session persistence", () => {
  test("保存并恢复尚未消费的运行中消息", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "queued-session",
        history: [
          {role: "system", content: "system"},
          {role: "user", content: "原始任务"},
        ],
        todos: [],
        permissionMode: "default",
        queuedInputs: [{
          id: "queued-1",
          type: "user_input",
          priority: "later",
          content: "恢复后继续",
          createdAt: "2026-07-20T00:00:00.000Z",
        }],
      });

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
        { role: "user", content: "第一个任务" },
        { role: "assistant", content: "已完成" },
      ];
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "session-1",
        history,
        todos: [],
        permissionMode: "default",
        compactState: createCompactState(),
        toolDiscovery: {
          version: 1,
          discoveredNames: ["mcp__fixture__echo"],
        },
      });

      const index = listSessionIndex(storage, cwd);
      expect(index).toHaveLength(1);
      expect(index[0]).toMatchObject({
        sessionId: "session-1",
        firstPrompt: "第一个任务",
        lastPrompt: "第一个任务",
        messageCount: 2,
      });

      const loaded = loadSession(storage, cwd, "session-1", "glm-test");
      expect(loaded?.history[0]?.role).toBe("system");
      expect(loaded?.history.filter((message) => message.role === "system")).toHaveLength(1);
      expect(loaded?.history.slice(-2)).toEqual(history.slice(-2));
      expect(loaded?.toolDiscovery).toEqual({
        version: 1,
        discoveredNames: ["mcp__fixture__echo"],
      });
      const snapshot = JSON.parse(
        await readFile(
          getSessionLogPath(storage, cwd, "session-1"),
          "utf8"
        )
      );
      expect(snapshot.version).toBe(2);
      expect((await stat(getSessionIndexPath(storage, cwd))).mode & 0o777).toBe(0o600);
      expect((await stat(getSessionLogPath(storage, cwd, "session-1"))).mode & 0o777)
        .toBe(0o600);
      expect((await stat(dirname(
        getSessionLogPath(storage, cwd, "session-1")
      ))).mode & 0o777).toBe(0o700);
      expect(loadLatestSession(storage, cwd, "glm-test")?.sessionId).toBe("session-1");
    });
  });

  test("不读取版本 1 或缺少当前格式版本的旧 snapshot", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "unversioned",
        history: [
          {role: "system", content: "system"},
          {role: "user", content: "旧对话"},
        ],
        todos: [],
        permissionMode: "default",
      });
      const path = getSessionLogPath(storage, cwd, "unversioned");
      const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      snapshot.version = 1;
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
      expect(loadSession(storage, cwd, "unversioned", "glm-test")).toBeNull();

      delete snapshot.version;
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");

      expect(loadSession(storage, cwd, "unversioned", "glm-test")).toBeNull();
      expect(listSessionIndex(storage, cwd)).toEqual([]);
    });
  });

  test("turn checkpoint 保存提交前状态且不影响最新 snapshot 恢复", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionTurnCheckpoint(storage, {
        cwd,
        model: "glm-test",
        sessionId: "checkpoint-session",
        checkpointId: "checkpoint-1",
        branchId: "branch-1",
        prompt: "下一步修改",
        history: [
          {role: "system", content: "system"},
          {role: "user", content: "上一轮"},
          {role: "assistant", content: "上一轮完成"},
        ],
        todos: [{
          content: "保留 todo",
          status: "pending",
          activeForm: "正在保留 todo",
        }],
        permissionMode: "acceptEdits",
        compactState: createCompactState(),
        toolDiscovery: {
          version: 1,
          discoveredNames: ["mcp__fixture__echo"],
        },
      });
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "checkpoint-session",
        history: [
          {role: "system", content: "system"},
          {role: "user", content: "下一步修改"},
          {role: "assistant", content: "修改完成"},
        ],
        todos: [],
        permissionMode: "default",
        checkpointHead: {
          branchId: "branch-1",
          checkpointId: "checkpoint-1",
        },
      });

      expect(listSessionTurnCheckpoints(storage, cwd, "checkpoint-session")).toHaveLength(1);
      expect(
        loadSessionTurnCheckpoint(storage, cwd, "checkpoint-session", "checkpoint-1")
      ).toMatchObject({
        prompt: "下一步修改",
        conversation: [
          {role: "user", content: "上一轮"},
          {role: "assistant", content: "上一轮完成"},
        ],
        permissionMode: "acceptEdits",
        toolDiscovery: {
          version: 1,
          discoveredNames: ["mcp__fixture__echo"],
        },
      });
      expect(loadSession(storage, cwd, "checkpoint-session", "glm-test")).toMatchObject({
        checkpointHead: {
          branchId: "branch-1",
          checkpointId: "checkpoint-1",
        },
      });
      expect(loadSession(storage, cwd, "checkpoint-session", "glm-test")?.history.at(-1))
        .toEqual({role: "assistant", content: "修改完成"});
    });
  });

  test("忽略末尾损坏行并恢复最后一个有效 snapshot", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "session-2",
        history: [
          { role: "system", content: "system" },
          { role: "user", content: "保留我" },
        ],
        todos: [],
        permissionMode: "default",
      });
      await appendFile(
        getSessionLogPath(storage, cwd, "session-2"),
        "{partial-json"
      );

      const loaded = loadSession(storage, cwd, "session-2", "glm-test");
      expect(loaded?.history.at(-1)).toEqual({ role: "user", content: "保留我" });

      await saveSessionTurnCheckpoint(storage, {
        cwd,
        model: "glm-test",
        sessionId: "session-2",
        checkpointId: "after-partial-tail",
        branchId: "branch-1",
        prompt: "继续",
        history: loaded?.history ?? [],
        todos: [],
        permissionMode: "default",
      });
      const repairedLines = (await readFile(
        getSessionLogPath(storage, cwd, "session-2"),
        "utf8"
      )).trim().split("\n");
      expect(repairedLines.every((line) => Boolean(JSON.parse(line)))).toBe(true);
      expect(repairedLines).toHaveLength(2);
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
          {role: "user", content: "原始任务"},
        ],
        todos: [],
        permissionMode: "default",
      });
      const path = getSessionLogPath(storage, cwd, "untrusted-session");
      const snapshot = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;

      snapshot.cwd = `${cwd}-other`;
      await writeFile(path, `${JSON.stringify(snapshot)}\n`, "utf8");
      expect(loadSession(storage, cwd, "untrusted-session", "glm-test")).toBeNull();
      expect(listSessionIndex(storage, cwd)).toEqual([]);

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
      expect(loadSession(storage, cwd, "untrusted-session", "glm-test")).toBeNull();
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
          {role: "user", content: "保留"},
        ],
        todos: [],
        permissionMode: "default",
      });
      const path = getSessionLogPath(storage, cwd, "strict-mutation");
      await appendFile(path, "{}\n");
      const before = await readFile(path, "utf8");

      await expect(saveSessionSnapshot(storage, {
        cwd,
        model: "glm-test",
        sessionId: "strict-mutation",
        history: [
          {role: "system", content: "system"},
          {role: "user", content: "下一次"},
        ],
        todos: [],
        permissionMode: "default",
      })).rejects.toThrow("Cannot update invalid session log");
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
        permissionMode: "default",
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
        permissionMode: "default",
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
          { role: "user", content: "修改 a" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "需要修改文件",
            tool_calls: [{
              id: "edit-a",
              type: "function",
              function: { name: "edit_file", arguments: "{}" },
            }],
          },
          { role: "tool", content: "已修改", tool_call_id: "edit-a" },
        ],
        todos: [],
        permissionMode: "default",
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
        reasoning_content: "需要修改文件",
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
              { role: "user", content: `task-${index}` },
            ],
            todos: [],
            permissionMode: "default",
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
              { role: "user", content: `shared-${index}` },
            ],
            todos: [],
            permissionMode: "default",
          })
        )
      );

      const lines = (
        await readFile(getSessionLogPath(storage, cwd, "shared"), "utf8")
      )
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      expect(lines.every((line) => JSON.parse(line).type === "snapshot")).toBe(true);
      expect(listSessionIndex(storage, cwd)).toHaveLength(1);
      expect(loadSession(storage, cwd, "shared", "glm-test")).not.toBeNull();
    });
  });

  test("重复保存只替换 snapshot，保留 turn checkpoint", async () => {
    await withTempProject(async (cwd, storage) => {
      await saveSessionTurnCheckpoint(storage, {
        cwd,
        model: "glm-test",
        sessionId: "compact-log",
        checkpointId: "checkpoint-1",
        branchId: "branch-1",
        prompt: "修改前",
        history: [{role: "system", content: "system"}],
        todos: [],
        permissionMode: "default",
      });
      for (const content of ["first", "latest"]) {
        await saveSessionSnapshot(storage, {
          cwd,
          model: "glm-test",
          sessionId: "compact-log",
          history: [
            {role: "system", content: "system"},
            {role: "user", content},
          ],
          todos: [],
          permissionMode: "default",
        });
      }

      const lines = (await readFile(
        getSessionLogPath(storage, cwd, "compact-log"),
        "utf8"
      )).trim().split("\n").map((line) => JSON.parse(line) as {type: string});
      expect(lines.map((line) => line.type)).toEqual([
        "turn_checkpoint",
        "snapshot",
      ]);
      expect(loadSession(storage, cwd, "compact-log", "glm-test")?.history.at(-1))
        .toEqual({role: "user", content: "latest"});
    });
  });

  test("Session turn checkpoint 与文件 Checkpoint 一样最多保留 100 个", async () => {
    await withTempProject(async (cwd, storage) => {
      for (let index = 0; index < 101; index++) {
        await saveSessionTurnCheckpoint(storage, {
          cwd,
          model: "glm-test",
          sessionId: "bounded-checkpoints",
          checkpointId: `checkpoint-${index}`,
          branchId: "branch-1",
          prompt: `turn-${index}`,
          history: [{role: "system", content: "system"}],
          todos: [],
          permissionMode: "default",
        });
      }

      const checkpoints = listSessionTurnCheckpoints(
        storage,
        cwd,
        "bounded-checkpoints"
      );
      expect(checkpoints).toHaveLength(100);
      expect(checkpoints[0]?.checkpointId).toBe("checkpoint-1");
      expect(checkpoints.at(-1)?.checkpointId).toBe("checkpoint-100");
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
          { role: "user", content: "existing" },
        ],
        todos: [],
        permissionMode: "default",
      });
      await writeFile(indexPath, "{corrupt-index", "utf8");

      await expect(
        saveSessionSnapshot(storage, {
          cwd,
          model: "glm-test",
          sessionId: "after-corruption",
          history: [
            { role: "system", content: "system" },
            { role: "user", content: "recoverable" },
          ],
          todos: [],
          permissionMode: "default",
        })
      ).rejects.toThrow("Cannot update corrupt session index");
      expect(await readFile(indexPath, "utf8")).toBe("{corrupt-index");
      expect(loadSession(storage, cwd, "after-corruption", "glm-test")?.history.at(-1)).toEqual({
        role: "user",
        content: "recoverable",
      });
    });
  });
});
