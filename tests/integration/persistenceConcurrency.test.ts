import { describe, expect, test } from "bun:test";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listSessionIndex } from "../../src/session/index.js";
import {getArtifactKey} from "../../src/toolResults/paths.js";
import { withTempProject } from "../helpers/tempProject.js";
import { createTestToolResultStore } from "../helpers/toolResultStore.js";
import {MemoryPublicationStore} from "../../src/memory/publicationStore.js";
import {createTestStorage} from "../helpers/tempProject.js";

const workerPath = join(import.meta.dir, "..", "fixtures", "persistenceWorker.ts");

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`worker did not become ready: ${path}`);
}

async function runConcurrentWorkers(
  cwd: string,
  mode:
    | "session"
    | "permission"
    | "memory"
    | "tool-result-quota"
    | "tool-result-binary",
  count: number
): Promise<string[]> {
  const barrierPath = join(cwd, `${mode}.barrier`);
  const readyPaths = [join(cwd, `${mode}.a.ready`), join(cwd, `${mode}.b.ready`)];
  const workers = ["a", "b"].map((prefix, index) =>
    Bun.spawn({
      cmd: [
        process.execPath,
        workerPath,
        mode,
        cwd,
        prefix,
        String(count),
        readyPaths[index]!,
        barrierPath,
      ],
      stdout: "ignore",
      stderr: "pipe",
    })
  );

  try {
    await Promise.all(readyPaths.map(waitForFile));
    await writeFile(barrierPath, "go\n", "utf8");
    const exitCodes = await Promise.race([
      Promise.all(workers.map((worker) => worker.exited)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${mode} workers timed out`)), 8_000)
      ),
    ]);
    const errors = await Promise.all(
      workers.map((worker) => new Response(worker.stderr).text())
    );
    expect(exitCodes, errors.join("\n")).toEqual([0, 0]);
    return readyPaths.map((path) => `${path}.result.json`);
  } finally {
    for (const worker of workers) {
      if (worker.exitCode === null) worker.kill();
    }
  }
}

describe("cross-process persistence", () => {
  test("两个进程同时保存 session 时 index 不丢条目", async () => {
    await withTempProject(async (cwd, storage) => {
      await runConcurrentWorkers(cwd, "session", 8);
      expect(
        listSessionIndex(storage, cwd)
          .map((entry) => entry.sessionId)
          .sort()
      ).toEqual(
        ["a", "b"]
          .flatMap((prefix) =>
            Array.from({ length: 8 }, (_, index) => `${prefix}-${index}`)
          )
          .sort()
      );
    });
  });

  test("两个进程同时添加权限规则时保留完整并集", async () => {
    await withTempProject(async (cwd) => {
      await runConcurrentWorkers(cwd, "permission", 8);
      const settings = JSON.parse(
        await readFile(join(cwd, ".pillar", "settings.local.json"), "utf8")
      );
      expect([...settings.permissions.allow].sort()).toEqual(
        ["a", "b"]
          .flatMap((prefix) =>
            Array.from({ length: 8 }, (_, index) => `${prefix}_tool_${index}`)
          )
          .sort()
      );
    });
  });

  test("两个进程同时写 Memory 时主题和派生索引不丢条目", async () => {
    await withTempProject(async (cwd) => {
      await runConcurrentWorkers(cwd, "memory", 8);
      const scan = new MemoryPublicationStore(createTestStorage(cwd),cwd).snapshot();
      expect(scan.sources.map((entry) => entry.key).sort()).toEqual(
        ["a", "b"]
          .flatMap((prefix) =>
            Array.from({ length: 8 }, (_, index) => `${prefix}-topic-${index}`)
          )
          .sort()
      );
      expect(scan.revision).toBe(16);
    });
  });

  test("两个进程共享 Tool Result session 时不突破 committed quota", async () => {
    await withTempProject(async (cwd) => {
      await runConcurrentWorkers(cwd, "tool-result-quota", 1);
      const store = createTestToolResultStore(cwd, "shared-tool-result", {
        pillarHome: join(cwd, "tool-result-artifacts"),
        maxArtifactBytes: 100,
        maxSessionBytes: 100,
      });
      const contentFiles = (await readdir(store.sessionDir)).filter((name) =>
        name.endsWith(".txt") || name.endsWith(".bin")
      );
      const committedBytes = (
        await Promise.all(
          contentFiles.map(async (name) => (await stat(join(store.sessionDir, name))).size)
        )
      ).reduce((sum, size) => sum + size, 0);
      expect(committedBytes).toBe(100);
    });
  });

  test("两个进程写同一 binary id 时返回同一个自洽 committed pair", async () => {
    await withTempProject(async (cwd) => {
      const resultPaths = await runConcurrentWorkers(
        cwd,
        "tool-result-binary",
        1
      );
      const store = createTestToolResultStore(cwd, "shared-binary", {
        pillarHome: join(cwd, "tool-result-artifacts"),
      });
      const key = getArtifactKey("shared-binary", "shared-artifact");
      const metadata = JSON.parse(
        await readFile(join(store.sessionDir, `${key}.binary.json`), "utf8")
      );
      const actualBytes = (await stat(join(store.sessionDir, `${key}.bin`))).size;
      const results = await Promise.all(
        resultPaths.map(async (path) => JSON.parse(await readFile(path, "utf8")))
      );

      expect(actualBytes).toBe(metadata.byteLength);
      for (const result of results) {
        expect(result).toEqual({ ...metadata, path: join(store.sessionDir, `${key}.bin`) });
      }
    });
  });
});
