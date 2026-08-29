import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInputHistoryStore } from "../../src/session/inputHistory/index.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("persistent input history", () => {
  test("全局 JSONL 按 Session 和项目过滤、最近优先去重并跳过损坏行", async () => {
    await withTempProject(async (root) => {
      const projectA = join(root, "a");
      const projectB = join(root, "b");
      const historyPath = join(root, "user", "history.jsonl");
      const sessionA = "session-a";
      const sessionB = "session-b";
      await Promise.all([
        mkdir(projectA, { recursive: true }),
        mkdir(projectB, { recursive: true }),
      ]);
      const store = createInputHistoryStore({ historyPath });

      await store.append(projectA, sessionA, "第一条");
      await store.append(projectB, sessionA, "其他项目");
      await store.append(projectA, sessionA, "第二条");
      await store.append(projectA, sessionB, "同项目的其他会话");
      await store.append(projectA, sessionA, "第一条");
      await appendFile(
        historyPath,
        `${JSON.stringify({
          version: 1,
          input: "旧版项目级历史",
          project: projectA,
          timestamp: new Date().toISOString(),
        })}\n损坏的尾行`,
        "utf8"
      );

      expect(await store.load(projectA, sessionA)).toEqual(["第二条", "第一条"]);
      expect(await store.load(projectA, sessionB)).toEqual(["同项目的其他会话"]);
      expect(await store.load(projectB, sessionA)).toEqual(["其他项目"]);
      if (process.platform !== "win32") {
        expect((await stat(historyPath)).mode & 0o777).toBe(0o600);
      }
    });
  });

  test("并发 append 不丢失不同输入", async () => {
    await withTempProject(async (cwd) => {
      const historyPath = join(cwd, "user", "history.jsonl");
      const store = createInputHistoryStore({ historyPath, limit: 50 });
      const inputs = Array.from({ length: 12 }, (_, index) => `prompt-${index}`);

      await Promise.all(
        inputs.map((input) => store.append(cwd, "session-a", input))
      );

      expect(await store.load(cwd, "session-a")).toEqual(inputs);
    });
  });

  test("超过 1 MiB 的输入只留在当前 UI，不写入用户历史", async () => {
    await withTempProject(async (cwd) => {
      const historyPath = join(cwd, "user", "history.jsonl");
      const store = createInputHistoryStore({ historyPath });

      await store.append(cwd, "session-a", "x".repeat(1024 * 1024 + 1));

      expect(await store.load(cwd, "session-a")).toEqual([]);
    });
  });
});
