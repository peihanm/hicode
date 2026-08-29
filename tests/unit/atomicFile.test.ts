import { describe, expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  createAtomicFileWriter,
  nodeAtomicFileOperations,
} from "../../src/persistence/atomicFile.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("writeFileAtomically", () => {
  test("完整替换目标并清理临时文件", async () => {
    await withTempProject(async (cwd) => {
      const target = join(cwd, "state.json");
      await writeFile(target, "old\n", "utf8");
      await createAtomicFileWriter({
        createToken: () => "success",
      })(target, "new\n");

      expect(await readFile(target, "utf8")).toBe("new\n");
      expect((await readdir(cwd)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  test("rename 失败时保留旧文件并清理临时文件", async () => {
    await withTempProject(async (cwd) => {
      const target = join(cwd, "state.json");
      await writeFile(target, "old\n", "utf8");
      const operations = {
        ...nodeAtomicFileOperations,
        async rename() {
          throw new Error("rename failed");
        },
      };

      await expect(
        createAtomicFileWriter({
          operations,
          createToken: () => "failure",
        })(target, "new\n")
      ).rejects.toThrow("rename failed");
      expect(await readFile(target, "utf8")).toBe("old\n");
      expect((await readdir(cwd)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  for (const stage of ["write", "sync", "close"] as const) {
    test(`${stage} 失败时保留旧文件并清理临时文件`, async () => {
      await withTempProject(async (cwd) => {
        const target = join(cwd, "state.json");
        await writeFile(target, "old\n", "utf8");
        const operations = {
          ...nodeAtomicFileOperations,
          async open(path: string, flags: string): Promise<FileHandle> {
            const handle = await nodeAtomicFileOperations.open(path, flags);
            let closeFailed = false;
            return {
              writeFile: async (...args: Parameters<FileHandle["writeFile"]>) => {
                if (stage === "write") throw new Error("write failed");
                return handle.writeFile(...args);
              },
              sync: async () => {
                if (stage === "sync") throw new Error("sync failed");
                return handle.sync();
              },
              close: async () => {
                if (stage === "close" && !closeFailed) {
                  closeFailed = true;
                  await handle.close();
                  throw new Error("close failed");
                }
                return handle.close();
              },
            } as unknown as FileHandle;
          },
        };

        await expect(
          createAtomicFileWriter({ operations })(target, "new\n")
        ).rejects.toThrow(`${stage} failed`);
        expect(await readFile(target, "utf8")).toBe("old\n");
        expect((await readdir(cwd)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      });
    });
  }

  test("目录 sync 不支持时不误报已经成功的替换", async () => {
    await withTempProject(async (cwd) => {
      const target = join(cwd, "state.json");
      await createAtomicFileWriter({
        operations: {
          ...nodeAtomicFileOperations,
          async syncDirectory() {
            throw new Error("unsupported");
          },
        },
      })(target, "saved\n");
      expect(await readFile(target, "utf8")).toBe("saved\n");
    });
  });
});
