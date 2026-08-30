import { describe, expect, test } from "bun:test";
import {mkdir, readFile, symlink, writeFile} from "node:fs/promises";
import {dirname, relative} from "node:path";
import {SubagentTranscriptWriter} from "../../src/subagents/transcript.js";
import { withTempProject } from "../helpers/tempProject.js";

describe("subagent transcript", () => {
  test("标识经过哈希，不能穿越工作目录", async () => {
    await withTempProject(async (cwd, storage) => {
      const writer = new SubagentTranscriptWriter(
        storage,
        cwd,
        "../../parent",
        "../../../agent"
      );
      expect(relative(cwd, writer.path).startsWith("..")).toBe(false);
      expect(writer.path).not.toContain("../");
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

  test("拒绝把 transcript 追加到 symlink 目标", async () => {
    await withTempProject(async (cwd, storage) => {
      const writer = new SubagentTranscriptWriter(
        storage,
        cwd,
        "parent-session",
        "child-agent"
      );
      const target = `${cwd}/private-target.txt`;
      await writeFile(target, "private\n");
      await mkdir(dirname(writer.path), {recursive: true});
      await symlink(target, writer.path);

      await expect(writer.append({
        type: "event",
        timestamp: "2026-07-12T00:00:00.000Z",
        event: {type: "iteration", current: 1, max: 2},
      })).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("private\n");
    });
  });
});
