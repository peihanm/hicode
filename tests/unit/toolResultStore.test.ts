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
import {readSavedOutput} from "../../src/tools/readFile/savedOutput.js";
import {buildPersistedToolResultMessage} from "../../src/toolResults/format.js";

describe("ToolResultStore", () => {
  test("文本落盘和 capture 都展示真实首尾，Grep 提示指向已有结果", async () => {
    await withTempProject(async cwd => {
      const store = createTestToolResultStore(cwd, "preview");
      const content = `START\n${"你😀pass\n".repeat(6000)}ERR_ASSERTION: final failure\n`;
      const capture = await store.createCapture();
      await writeFile(capture, content);
      const results = [
        await store.persistText({toolCallId: "text", toolName: "test", content}),
        await store.promoteFile({toolCallId: "capture", toolName: "bash", sourcePath: capture}),
      ];
      for (const result of results) {
        expect(result.preview.startsWith("START\n")).toBe(true);
        expect(result.preview.endsWith("ERR_ASSERTION: final failure\n")).toBe(true);
        expect(result.preview).toContain("[middle omitted]");
        expect(result.preview.length).toBeLessThanOrEqual(store.previewChars);
        expect(Buffer.from(result.preview).toString("utf8")).toBe(result.preview);
        expect(await readFile(result.path, "utf8")).toBe(content);
        const message = buildPersistedToolResultMessage(result);
        expect(message).toContain("Complete: yes");
        expect(message).toContain(JSON.stringify(result.path));
        expect(message).toContain("use grep on the saved file path");
        expect(message).toContain("read_file");
        expect(message).not.toContain("Preview (first");
      }
    });
  });

  test("配额截断仅展示已保存部分的末尾，不伪称原始输出完整", async () => {
    await withTempProject(async cwd => {
      const saved = `START\n${"x".repeat(12000)}SAVED-END`;
      const store = createTestToolResultStore(cwd, "partial-preview", {maxArtifactBytes: saved.length});
      const capture = await store.createCapture();
      await writeFile(capture, `${saved}\nUNSAVED-FAILURE`);
      const result = await store.promoteFile({toolCallId: "partial", toolName: "bash", sourcePath: capture});
      expect(result.preview.endsWith("SAVED-END")).toBe(true);
      const message = buildPersistedToolResultMessage(result);
      expect(message).toContain("Complete: no");
      expect(message).toContain("not necessarily the end of the original output");
      expect(message).not.toContain("UNSAVED-FAILURE");
    });
  });

  test("超过旧 1 MiB 上限的结果仍引导 Grep 定位", async () => {
    await withTempProject(async cwd => {
      const store = createTestToolResultStore(cwd, "large-preview");
      const result = await store.persistText({toolCallId: "large", toolName: "test", content: "x".repeat(1024 * 1024 + 1)});
      const message = buildPersistedToolResultMessage(result);
      expect(message).not.toContain("exceeds grep");
      expect(message).toContain("use grep on the saved file path");
      expect(message).toContain(JSON.stringify(result.path));
    });
  });
  test("capture 在单项和剩余 Session 配额的多字节边界截断后能到 EOF", async () => {
    await withTempProject(async (cwd) => {
      for (const char of ["é", "你", "😀"]) {
        for (const sessionQuota of [false, true]) {
          const size = Buffer.byteLength(char);
          const store = createTestToolResultStore(cwd, `${size}-${sessionQuota}`, {
            maxArtifactBytes: sessionQuota ? 100 : size * 2 - 1,
            maxSessionBytes: sessionQuota ? size * 2 : 100,
          });
          if (sessionQuota) await store.persistText({toolCallId: "prior", toolName: "test", content: "x"});
          const sourcePath = await store.createCapture();
          await writeFile(sourcePath, char.repeat(2));
          const result = await store.promoteFile({toolCallId: "capture", toolName: "bash", sourcePath});
          expect(result).toMatchObject({byteLength: size, originalByteLength: size * 2, complete: false});
          expect(await readFile(result.path, "utf8")).toBe(char);
        }
      }
    });
  });

  test("损坏尾字符明确失败，不产生永不推进的空页", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "damaged-tail");
      const result = await store.persistText({toolCallId: "text", toolName: "test", content: "abcde"});
      await writeFile(result.path, Buffer.from([97, 98, 99, 0xe4, 0xbd]));
      await expect(readSavedOutput(result, 1, 10, new AbortController().signal)).rejects.toThrow();
    });
  });

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

  test("持久化文本按大小限制且保留完整 UTF-8 字符", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "session-a", {
        pillarHome: join(cwd, "store"),
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

      const reconstructed = await readFile(persisted.path, "utf8");
      expect(reconstructed).not.toContain("�");
      expect(Buffer.byteLength(reconstructed)).toBe(persisted.byteLength);
    });
  });

  test("promoteFile 只接受当前 Session capture", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "session-b", {
        pillarHome: join(cwd, "store"),
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
        pillarHome: join(cwd, "store"),
        maxArtifactBytes: 8,
        maxSessionBytes: 8,
      });
      const artifact = await store.persistBinary({
        origin: {kind: "tool", toolCallId: "binary-call", toolName: "mcp__fixture__binary"},
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
      const pillarHome = join(cwd, "store");
      const first = createTestToolResultStore(cwd, "session-one", {pillarHome});
      const second = createTestToolResultStore(cwd, "session-two", {pillarHome});
      const persisted = await first.persistText({
        toolCallId: "same-call",
        toolName: "test",
        content: "private session output",
      });
      await expect(second.resolveFile(persisted.path)).rejects.toThrow("Access denied");
    });
  });

  test("并发持久化仍严格遵守 Session committed bytes 配额", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "concurrent-quota", {
        pillarHome: join(cwd, "store"),
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
        pillarHome: join(cwd, "store"),
      });
      const results = await Promise.all([
        store.persistBinary({
          origin: {kind: "tool", toolCallId: "binary-a", toolName: "mcp"},
          artifactId: "shared-binary",
          data: Buffer.alloc(10, 1),
          mimeType: "a/type",
        }),
        store.persistBinary({
          origin: {kind: "tool", toolCallId: "binary-b", toolName: "mcp"},
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
          origin: metadata.origin,
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
        pillarHome: join(cwd, "store"),
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

  test("崩溃留下的 content-only 文件不占用 committed quota", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "orphan-quota", {
        pillarHome: join(cwd, "store"),
        maxArtifactBytes: 5,
        maxSessionBytes: 5,
      });
      await mkdir(store.sessionDir, { recursive: true });
      await writeFile(join(store.sessionDir, "orphan.txt"), "x".repeat(100));

      const persisted = await store.persistText({
        toolCallId: "fresh-call",
        toolName: "test",
        content: "hello",
      });

      expect(persisted.complete).toBe(true);
      expect(persisted.byteLength).toBe(5);
    });
  });

  test("读取时拒绝被替换为 symlink 的 content", async () => {
    if (process.platform === "win32") return;
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "symlink-content", {
        pillarHome: join(cwd, "store"),
      });
      const persisted = await store.persistText({
        toolCallId: "safe-call",
        toolName: "test",
        content: "saved",
      });
      const outside = join(cwd, "outside.txt");
      await writeFile(outside, "saved");
      await rm(persisted.path);
      await symlink(outside, persisted.path);

      await expect(
        store.resolveFile(persisted.path)
      ).rejects.toThrow("invalid tool result file");
    });
  });

  test("安全修复 metadata-only binary pair 并忽略 metadata 中的旧 path", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "repair-binary", {
        pillarHome: join(cwd, "store"),
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
        origin: {kind: "tool", toolCallId: "new-call", toolName: "mcp"},
        data: Buffer.from([1, 2, 3]),
        mimeType: "application/octet-stream",
      });
      expect(artifact).toMatchObject({
        origin: {kind: "tool", toolCallId: "new-call", toolName: "mcp"},
        byteLength: 3,
        mimeType: "application/octet-stream",
      });
      expect(artifact.path).toBe(join(store.sessionDir, `${key}.bin`));
      expect([...await readFile(artifact.path)]).toEqual([1, 2, 3]);
    });
  });

  test("metadata 存在但 content 丢失时 路径解析返回领域错误", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "missing-content", {
        pillarHome: join(cwd, "store"),
      });
      const persisted = await store.persistText({
        toolCallId: "missing-call",
        toolName: "test",
        content: "saved",
      });
      await rm(persisted.path);

      await expect(
        store.resolveFile(persisted.path)
      ).rejects.toMatchObject({
        name: "ToolResultStoreError",
        message: "invalid tool result file",
      });
    });
  });

  test("remove 与同 ID persist 并发后不会留下半个 artifact pair", async () => {
    await withTempProject(async (cwd) => {
      const store = createTestToolResultStore(cwd, "remove-race", {
        pillarHome: join(cwd, "store"),
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
