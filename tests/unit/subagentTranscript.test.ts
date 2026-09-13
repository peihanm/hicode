import type {Message} from "../../src/llm/types.js";
import type {SubagentResult} from "../../src/subagents/types.js";
import { describe, expect, test } from "bun:test";
import {mkdir, readFile, symlink, writeFile, stat} from "node:fs/promises";
import {dirname, relative, join} from "node:path";
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

test("subagent followups append deltas and expose a standalone latest state",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const writer=new SubagentTranscriptWriter(storage,cwd,"parent","agent");
  const history:Message[]=[{role:"user",origin:"user",content:"x".repeat(100_000)}];
  const result:SubagentResult={agentId:"agent",agentType:"Explore",description:"test",reply:"ok",reason:"completed",iterations:1,toolUseCount:0,durationMs:1};
  for(let i=0;i<10;i++){
   history.push({role:"assistant",content:`reply ${i}`});
   await writer.append({type:"snapshot",timestamp:new Date().toISOString(),history,result});
  }
  expect((await stat(writer.path)).size).toBeLessThan(130_000);
  const state=JSON.parse(await readFile(join(dirname(writer.path),"state.json"),"utf8"));
  expect(state.history).toHaveLength(11);
  const events=(await readFile(writer.path,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  expect(events[1].historyDelta.retained).toBe(2);expect(events[1].historyDelta.appended).toHaveLength(1);
 });
});
