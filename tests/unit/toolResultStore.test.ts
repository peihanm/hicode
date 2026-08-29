import { describe, expect, test } from "bun:test";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {getArtifactKey} from "../../src/toolResults/paths.js";
import { getProjectKey } from "../../src/persistence/index.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTestToolResultStore } from "../helpers/toolResultStore.js";

describe("ToolResultStore", () => {
  test("project key 稳定隔离且 artifact key 不暴露输入路径", async () => {
    await withTempProject(async (cwd) => {
      const other = join(cwd, "other");
      await mkdir(other);
      expect(getProjectKey(cwd)).not.toBe(getProjectKey(other));
      expect(getArtifactKey("session", "../../escape")).toMatch(/^[a-f0-9]{32}$/);

      if (process.platform !== "win32") {
        const alias = join(cwd, "alias");
        await symlink(other, alias);
        expect(getProjectKey(alias)).toBe(getProjectKey(other));
      }
    });
  });

  test("持久化文本、限制大小并按 UTF-8 byte 安全分页", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "session-a", {
        rootDir: join(cwd, "store"),
        maxArtifactBytes: 64,
        maxSessionBytes: 128,
        previewChars: 8,
      });
      const content = `甲乙丙丁-${"x".repeat(80)}`;
      const persisted = await store.persistText({
        toolCallId: "call/../unsafe",
        toolName: "test",
        content,
      });

      expect(persisted.complete).toBe(false);
      expect(persisted.byteLength).toBeLessThanOrEqual(64);
      expect(persisted.path.startsWith(store.sessionDir)).toBe(true);
      expect(persisted.path).not.toContain("unsafe");

      let offset = 0;
      let reconstructed = "";
      while (offset < persisted.byteLength) {
        const chunk = await store.readRange({
          resultId: persisted.resultId,
          offset,
          limit: 5,
        });
        reconstructed += chunk.content;
        expect(chunk.content).not.toContain("�");
        expect(chunk.nextOffset).toBeGreaterThan(offset);
        offset = chunk.nextOffset;
      }
      expect(Buffer.byteLength(reconstructed)).toBe(persisted.byteLength);
    });
  });

  test("promoteFile 只接受当前 Session capture", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "session-b", {
        rootDir: join(cwd, "store"),
      });
      const outside = join(cwd, "outside.txt");
      await writeFile(outside, "nope");
      await expect(
        store.promoteFile({
          toolCallId: "call",
          toolName: "bash",
          sourcePath: outside,
        })
      ).rejects.toThrow("outside the current session");
    });
  });

  test("二进制 Artifact 受 Session 配额约束且不会经过 UTF-8 解码", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "session-binary", {
        rootDir: join(cwd, "store"),
        maxArtifactBytes: 8,
        maxSessionBytes: 8,
      });
      const artifact = await store.persistBinary({
        toolCallId: "binary-call",
        toolName: "mcp__fixture__binary",
        data: Buffer.from([0, 255, 1, 254, 2, 253, 3, 252, 4]),
        mimeType: "application/octet-stream",
      });
      expect(artifact).toMatchObject({
        encoding: "binary",
        mimeType: "application/octet-stream",
        byteLength: 8,
        originalByteLength: 9,
        complete: false,
      });
      expect([...await readFile(artifact.path)]).toEqual([0, 255, 1, 254, 2, 253, 3, 252]);
    });
  });

  test("不同 Session 不能通过相同 result id 互相读取", async () => {
    await withTempProject(async (cwd) => {
      const rootDir = join(cwd, "store");
      const first = createTestToolResultStore(cwd, "session-one", { rootDir });
      const second = createTestToolResultStore(cwd, "session-two", { rootDir });
      const persisted = await first.persistText({
        toolCallId: "same-call",
        toolName: "test",
        content: "private session output",
      });
      await expect(
        second.readRange({
          resultId: persisted.resultId,
          offset: 0,
          limit: 10,
        })
      ).rejects.toThrow("not found");
    });
  });

  test("并发持久化仍严格遵守 Session committed bytes 配额", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "concurrent-quota", {
        rootDir: join(cwd, "store"),
        maxArtifactBytes: 100,
        maxSessionBytes: 100,
      });
      const results = await Promise.all([
        store.persistText({
          toolCallId: "quota-a",
          toolName: "test",
          content: "a".repeat(80),
        }),
        store.persistText({
          toolCallId: "quota-b",
          toolName: "test",
          content: "b".repeat(80),
        }),
      ]);
      const contentFiles = (await readdir(store.sessionDir)).filter((name) =>
        name.endsWith(".txt") || name.endsWith(".bin")
      );
      const committedBytes = (
        await Promise.all(
          contentFiles.map(async (name) => (await stat(join(store.sessionDir, name))).size)
        )
      ).reduce((sum, size) => sum + size, 0);

      expect(results.reduce((sum, result) => sum + result.byteLength, 0)).toBe(100);
      expect(committedBytes).toBe(100);
    });
  });

  test("并发写相同 binary artifact 时所有返回值匹配唯一 committed pair", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "binary-race", {
        rootDir: join(cwd, "store"),
      });
      const results = await Promise.all([
        store.persistBinary({
          toolCallId: "binary-a",
          toolName: "mcp",
          artifactId: "shared-binary",
          data: Buffer.alloc(10, 1),
          mimeType: "a/type",
        }),
        store.persistBinary({
          toolCallId: "binary-b",
          toolName: "mcp",
          artifactId: "shared-binary",
          data: Buffer.alloc(20, 2),
          mimeType: "b/type",
        }),
      ]);
      const key = getArtifactKey("binary-race", "shared-binary");
      const metadata = JSON.parse(
        await readFile(join(store.sessionDir, `${key}.binary.json`), "utf8")
      );
      const actualBytes = (await stat(join(store.sessionDir, `${key}.bin`))).size;

      expect(actualBytes).toBe(metadata.byteLength);
      for (const result of results) {
        expect(result).toMatchObject({
          artifactId: metadata.artifactId,
          toolCallId: metadata.toolCallId,
          toolName: metadata.toolName,
          byteLength: metadata.byteLength,
          originalByteLength: metadata.originalByteLength,
          complete: metadata.complete,
          encoding: metadata.encoding,
          mimeType: metadata.mimeType,
        });
      }
    });
  });

  test("安全修复 content-only 和损坏 metadata artifact pair", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "repair-text", {
        rootDir: join(cwd, "store"),
      });
      await mkdir(store.sessionDir, { recursive: true });
      const resultId = store.resultIdFor("repair-call");
      const key = getArtifactKey("repair-text", resultId);
      const contentPath = join(store.sessionDir, `${key}.txt`);
      const metadataPath = join(store.sessionDir, `${key}.meta.json`);
      await writeFile(contentPath, "stale-content", "utf8");

      const repairedPartial = await store.persistText({
        toolCallId: "repair-call",
        toolName: "test",
        content: "fresh-content",
      });
      expect(await readFile(contentPath, "utf8")).toBe("fresh-content");
      expect(repairedPartial.preview).toBe("fresh-content");

      await writeFile(metadataPath, "{corrupt-metadata", "utf8");
      const repairedCorrupt = await store.persistText({
        toolCallId: "repair-call",
        toolName: "test",
        content: "newest-content",
      });
      expect(await readFile(contentPath, "utf8")).toBe("newest-content");
      expect(repairedCorrupt.preview).toBe("newest-content");
      expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
        resultId,
        byteLength: Buffer.byteLength("newest-content"),
      });
    });
  });

  test("安全修复 metadata-only binary pair 并忽略 metadata 中的旧 path", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "repair-binary", {
        rootDir: join(cwd, "store"),
      });
      await mkdir(store.sessionDir, { recursive: true });
      const artifactId = "repair-artifact";
      const key = getArtifactKey("repair-binary", artifactId);
      const metadataPath = join(store.sessionDir, `${key}.binary.json`);
      await writeFile(
        metadataPath,
        `${JSON.stringify({
          artifactId,
          toolCallId: "old-call",
          toolName: "old-tool",
          path: "/outside/stale.bin",
          byteLength: 4,
          originalByteLength: 4,
          complete: true,
          encoding: "binary",
          mimeType: "old/type",
        })}\n`,
        "utf8"
      );

      const artifact = await store.persistBinary({
        artifactId,
        toolCallId: "new-call",
        toolName: "mcp",
        data: Buffer.from([1, 2, 3]),
        mimeType: "application/octet-stream",
      });
      expect(artifact).toMatchObject({
        toolCallId: "new-call",
        byteLength: 3,
        mimeType: "application/octet-stream",
      });
      expect(artifact.path).toBe(join(store.sessionDir, `${key}.bin`));
      expect([...await readFile(artifact.path)]).toEqual([1, 2, 3]);
    });
  });

  test("metadata 存在但 content 丢失时 readRange 返回领域错误", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "missing-content", {
        rootDir: join(cwd, "store"),
      });
      const persisted = await store.persistText({
        toolCallId: "missing-call",
        toolName: "test",
        content: "saved",
      });
      await rm(persisted.path);

      await expect(
        store.readRange({ resultId: persisted.resultId, offset: 0, limit: 10 })
      ).rejects.toMatchObject({
        name: "ToolResultStoreError",
        message: `tool result content is missing: ${persisted.resultId}`,
      });
    });
  });

  test("remove 与同 ID persist 并发后不会留下半个 artifact pair", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "remove-race", {
        rootDir: join(cwd, "store"),
      });
      const first = await store.persistText({
        toolCallId: "same-call",
        toolName: "test",
        content: "first",
      });
      await Promise.all([
        store.removeArtifact(first.resultId),
        store.persistText({
          toolCallId: "same-call",
          toolName: "test",
          content: "second",
        }),
      ]);
      const key = getArtifactKey("remove-race", first.resultId);
      const paths = [
        join(store.sessionDir, `${key}.txt`),
        join(store.sessionDir, `${key}.meta.json`),
      ];
      const exists = await Promise.all(
        paths.map(async (path) => {
          try {
            await access(path);
            return true;
          } catch {
            return false;
          }
        })
      );
      expect(exists[0]).toBe(exists[1]);
    });
  });
});
