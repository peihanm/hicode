import {expect,test} from "bun:test";
import {readFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import {beginPromptLog,finishPromptLogRun} from "../../src/llm/promptLog.js";
import {getPromptLogDirectory} from "../../src/persistence/layout.js";
import {listPromptLogs} from "../helpers/promptLogs.js";
import {withTempProject} from "../helpers/tempProject.js";

test("request ownership stays with the parent session even when child cwd differs",async()=>{
 await withTempProject(async(cwd,storage)=>{
  const trace={scope:"session" as const,ownerCwd:cwd,sessionId:"parent",runId:"child-turn",agentId:"child"};
  const handle=beginPromptLog(storage,join(cwd,"other"),"main","test",{messages:[]},[],trace,2);
  handle.finish({error:"fixture complete"});finishPromptLogRun(storage,trace);
  const directory=getPromptLogDirectory(storage,cwd,"parent");
  const [file]=await listPromptLogs(directory),log=JSON.parse(await readFile(join(directory,file!),"utf8"));
  expect(log.trace).toEqual(trace);expect(log.attempt).toBe(2);expect(log.executionCwd).toBe(join(cwd,"other"));
  const [run]=await readdir(directory),state=JSON.parse(await readFile(join(directory,run!,"run.json"),"utf8"));
  expect(state.pending).toEqual([]);expect(state.completedAt).toBeDefined();
 });
});
