import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import {
  getSubagentTranscriptPath,
  SubagentTranscriptWriter,
} from "../../src/subagents/index.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("subagent transcript", () => {
  test("标识经过哈希，不能穿越工作目录", async () => {
    await withTempProject(async (cwd, storage) => {
      const path = getSubagentTranscriptPath(
        storage,
        cwd,
        "../../parent",
        "../../../agent"
      );
      expect(relative(cwd, path).startsWith("..")).toBe(false);
      expect(path).not.toContain("../");

      const writer = new SubagentTranscriptWriter(
        storage,
        cwd,
        "../../parent",
        "../../../agent"
      );
      await writer.append({
        type: "event",
        timestamp: "2026-07-12T00:00:00.000Z",
        event: { type: "iteration", current: 1, max: 2 },
      });
      const entry = JSON.parse((await readFile(writer.path, "utf8")).trim());
      expect(entry.type).toBe("event");
      expect(entry.event.type).toBe("iteration");
    });
  });
});
