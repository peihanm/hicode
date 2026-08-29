import { describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LSPManager } from "../../src/lsp/manager.js";
import { withTempProject } from "../helpers/tempProject.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/lsp/stdioServer.ts", import.meta.url)
);

describe("LSP stdio integration", () => {
  test("真实完成 initialize、diagnostics 和 shutdown/exit", async () => {
    await withTempProject(async (cwd) => {
      const pillarDir = join(cwd, ".pillar");
      const sourcePath = join(cwd, "fixture.fixture");
      const logPath = join(cwd, "lsp-events.log");
      await mkdir(pillarDir);
      await writeFile(sourcePath, "export const fixtureSymbol = true;\n");
      await writeFile(
        join(pillarDir, "lsp.json"),
        JSON.stringify({
          fixture: {
            command: process.execPath,
            args: [fixturePath, "--log", logPath],
            extensions: [".fixture"],
          },
        })
      );

      const manager = new LSPManager(cwd);
      try {
        const diagnostics = await manager.syncFileAndGetDiagnostics(
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
        await manager.shutdown();
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = await readFile(logPath, "utf8");
      expect(events).toContain("process/start");
      expect(events).toContain("initialize");
      expect(events).toContain("initialized");
      expect(events).toContain("textDocument/didOpen");
      expect(events).toContain("textDocument/didSave");
      expect(events).toContain("shutdown");
      expect(events).toContain("exit");
    });
  });
});
