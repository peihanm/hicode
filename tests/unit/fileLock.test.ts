import { describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  createFileLock,
  nodeFileLockOperations,
} from "../../src/persistence/fileLock.js";
import { withTempProject } from "../helpers/tempProject.js";

const withFileLock = createFileLock();

describe("withFileLock", () => {
  test("等待当前 owner 完成后按顺序进入临界区", async () => {
    await withTempProject(async (cwd) => {
      const lockPath = join(cwd, "state.lock");
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = withFileLock(lockPath, async () => {
        order.push("first:start");
        await gate;
        order.push("first:end");
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = withFileLock(lockPath, async () => {
        order.push("second");
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(order).toEqual(["first:start"]);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(["first:start", "first:end", "second"]);
    });
  });

  test("action 抛错后仍释放锁", async () => {
    await withTempProject(async (cwd) => {
      const lockPath = join(cwd, "state.lock");
      await expect(
        withFileLock(lockPath, async () => {
          throw new Error("action failed");
        })
      ).rejects.toThrow("action failed");
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(withFileLock(lockPath, async () => "ok")).resolves.toBe("ok");
    });
  });

  test("回收达到年龄且 owner 已不存在的 stale lock", async () => {
    await withTempProject(async (cwd) => {
      const lockPath = join(cwd, "state.lock");
      await writeFile(
        lockPath,
        `${JSON.stringify({
          version: 1,
          token: "dead-owner",
          pid: 999_999,
          createdAt: "2000-01-01T00:00:00.000Z",
        })}\n`,
        "utf8"
      );
      await expect(
        createFileLock({
          staleMs: 0,
          isProcessAlive: () => false,
        })(lockPath, async () => "recovered")
      ).resolves.toBe("recovered");
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("live lock 超时且不会被 stale recovery 删除", async () => {
    await withTempProject(async (cwd) => {
      const lockPath = join(cwd, "state.lock");
      const content = `${JSON.stringify({
        version: 1,
        token: "live-owner",
        pid: process.pid,
        createdAt: "2000-01-01T00:00:00.000Z",
      })}\n`;
      await writeFile(lockPath, content, "utf8");
      await expect(
        createFileLock({
          timeoutMs: 5,
          retryDelayMs: 1,
          staleMs: 0,
        })(lockPath, async () => "never")
      ).rejects.toThrow("Timed out waiting for persistence lock");
      expect(await readFile(lockPath, "utf8")).toBe(content);
    });
  });

  test("释放时 token 不匹配不会删除别人的锁", async () => {
    await withTempProject(async (cwd) => {
      const lockPath = join(cwd, "state.lock");
      await createFileLock({ createToken: () => "owner" })(
        lockPath,
        async () => {
          await writeFile(
            lockPath,
            `${JSON.stringify({
              version: 1,
              token: "replacement",
              pid: process.pid,
              createdAt: new Date().toISOString(),
            })}\n`,
            "utf8"
          );
        }
      );
      expect(JSON.parse(await readFile(lockPath, "utf8")).token).toBe("replacement");
    });
  });

  test("owner metadata 写入失败时不遗留不可解析的锁", async () => {
    await withTempProject(async (cwd) => {
      const lockPath = join(cwd, "state.lock");
      await expect(
        createFileLock({
          operations: {
            ...nodeFileLockOperations,
            async open(path: string, flags: string): Promise<FileHandle> {
              const handle = await nodeFileLockOperations.open(path, flags);
              if (path !== lockPath) return handle;
              return {
                writeFile: async () => {
                  throw new Error("metadata failed");
                },
                close: () => handle.close(),
              } as unknown as FileHandle;
            },
          },
        })(lockPath, async () => "never")
      ).rejects.toThrow("metadata failed");
      await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(withFileLock(lockPath, async () => "ok")).resolves.toBe("ok");
    });
  });
});
