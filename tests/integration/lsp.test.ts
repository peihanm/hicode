import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {createLspManager} from "../../src/lsp/manager.js";
import { withTempProject } from "../helpers/tempProject.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/lsp/stdioServer.ts", import.meta.url)
);

describe("LSP stdio integration", () => {
  test("真实完成 initialize、diagnostics 和 shutdown/exit", async () => {
    await withTempProject(async (cwd, storage) => {
      const pillarDir = storage.pillarHome;
      const sourcePath = join(cwd, "fixture.fixture");
      const logPath = join(cwd, "lsp-events.log");
      await mkdir(pillarDir);
      await writeFile(sourcePath, "export const fixtureSymbol = true;\n");
      await writeFile(
        join(pillarDir, "lsp.json"),
        JSON.stringify({
          fixture: {
            command: process.execPath,
            args: [
              fixturePath,
              "--log",
              logPath,
              "--env-name",
              "PILLAR_TEST_LSP_API_KEY",
            ],
            extensions: [".fixture"],
          },
        })
      );

      const childEnvironment = createChildProcessEnvironment({
        PATH: process.env.PATH,
        PILLAR_TEST_LSP_API_KEY: "must-not-leak",
      }, ["PILLAR_TEST_LSP_API_KEY"]);
      const manager = await createLspManager(
        storage,
        cwd,
        childEnvironment
      );
      expect(manager).toBeDefined();
      try {
        const diagnostics = await manager!.syncFileAndGetDiagnostics(
          sourcePath,
          "export const fixtureSymbol = true;\n",
          2_000
        );
        expect(diagnostics?.[0]).toMatchObject({
          source: "fixture-lsp",
          code: "FIXTURE",
          message: "fixture diagnostic",
        });
      } finally {
        await manager!.shutdown();
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = await readFile(logPath, "utf8");
      expect(events).toContain("process/start");
      expect(events).toContain("env:PILLAR_TEST_LSP_API_KEY=<missing>");
      expect(events).toContain("initialize");
      expect(events).toContain("initialized");
      expect(events).toContain("textDocument/didOpen");
      expect(events).toContain("textDocument/didSave");
      expect(events).toContain("shutdown");
      expect(events).toContain("exit");
    });
  });

  test("超大 LSP frame 会终止 Server 并拒绝请求", async () => {
    await withTempProject(async (cwd, storage) => {
      await mkdir(storage.pillarHome, {recursive: true});
      const sourcePath = join(cwd, "oversized.fixture");
      await writeFile(sourcePath, "const value = true;\n");
      await writeFile(join(storage.pillarHome, "lsp.json"), JSON.stringify({
        fixture: {
          command: process.execPath,
          args: [fixturePath, "--oversized-frame"],
          extensions: [".fixture"],
        },
      }));
      const manager = await createLspManager(
        storage,
        cwd,
        testChildEnvironment
      );
      expect(manager).toBeDefined();
      try {
        await expect(manager!.syncFileAndGetDiagnostics(
          sourcePath,
          "const value = true;\n",
          2_000
        )).rejects.toThrow("Content-Length exceeds limit");
      } finally {
        await manager!.shutdown();
      }
    });
  });
});
