import {expect, test} from "bun:test";
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createSubagentFactories} from "../../src/subagents/runSubagent.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {createToolResultStore} from "../../src/toolResults/store.js";
import {readLatestSessionSnapshot} from "../../src/session/snapshotStore.js";
import {repairSessionIndex} from "../../src/session/repair.js";
import {createSessionPersistence, listSessionIndex, loadSession} from "../../src/session/storage.js";
import {createSessionArchiveAccess, prepareSessionArchive} from "../../src/session/archive.js";
import {createCompactState} from "../../src/context/state.js";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {selectCompactInput} from "../../src/context/compactInput.js";
import {tokenCountWithEstimation} from "../../src/context/tokens.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import type {AgentRunner} from "../../src/agent/runner.js";
import type {Message} from "../../src/llm/types.js";

test("child owns durable compaction and reads only inherited parent archives across continuation", async () => {
 await withTempProject(async (cwd, storage) => {
  const ctx = createTestContext(cwd, {contextSettings: {windowTokens: 32768, autoCompactTokenLimit: 26000}});
  const original: Message[] = [{role:"system",content:"root"},{role:"user",origin:"user",content:"PARENT_EXACT_REQUIREMENT"}];
  const draft = prepareSessionArchive(storage,cwd,ctx.sessionId,original);
  const parentState = {...createCompactState(), compactCount:1, archives:[draft.record]};
  const inherited: Message[] = [original[0]!,{role:"user",origin:"compaction",content:`Evidence: ${draft.indexPath}`}];
  await createSessionPersistence(storage,cwd,ctx.sessionId).compact({cwd,sessionId:ctx.sessionId,model:ctx.model,
    history:inherited,compactState:parentState,todos:[],permissionMode:"ask",collaborationMode:"build",allowEmpty:true},draft,ctx.signal);
  Object.assign(ctx.compactState,parentState);
  ctx.sessionArchives = createSessionArchiveAccess(storage,cwd,ctx.sessionId,()=>ctx.compactState);
  const childCwd=join(cwd,"child"); await mkdir(childCwd);
  let runs=0;let childIndex="";
  const runner:AgentRunner=async(prompt,history,_onEvent,child,_channel,options)=>{
   runs++;
   expect(child.sessionCompaction).toBeDefined();
   expect((await child.sessionArchives!.resolve(draft.indexPath))?.complete).toBe(true);
   if(runs===1){
    history.push({role:"user",origin:"assignment",content:String(prompt)});
    for(let i=0;i<80;i++)history.push({role:"assistant",content:`evidence ${i} `+"detail ".repeat(1000)});
    for(let i=0;i<3;i++)history.push({role:"user",origin:"agent",content:`coordination ${i}`});
    const result=await createCompactHistoryRunner({generateSummary:async input=>{
      expect(input.sources).toBeDefined();
      const selection=selectCompactInput({...input,prompt:"summarize",budget:10000});
      expect(selection.coverage).toContain("omitted");
      expect(selection.messages.some(m=>m.content===prompt || typeof m.content==="string"&&m.content.includes(String(prompt)))).toBe(true);
      return "Retain the current assignment and consult evidence when needed.";
    }})({history,ctx:child,tools:[],preTokenCount:tokenCountWithEstimation(history),force:true});
    expect(result.message).toBeUndefined();
    expect(result.compacted).toBe(true);
    expect(history.some(m=>m.role==="user"&&m.origin==="assignment"&&m.content===prompt)).toBe(true);
    childIndex=child.sessionCompaction!.prepare(history).indexPath.replace(/[^/]+$/,child.compactState.archives![0]!.id+"-index.txt");
   }else{
    expect(child.compactState.compactCount).toBe(1);
    expect((await child.sessionArchives!.resolve(childIndex))?.complete).toBe(true);
    const read=await options.executeTool("read_file",JSON.stringify({path:childIndex}),child,"read-own");
    expect(typeof read !== "string" && read.outcome).toBe("ok");
   }
   return {reason:"completed",reply:"done",iterations:1};
  };
  const factory=createSubagentFactories({primaryRunAgent:runner,fastRunAgent:runner,registry:BUILTIN_SUBAGENT_REGISTRY,
    createToolResultStore:(cwd,id)=>createToolResultStore(storage,cwd,id)});
  const thread=factory.createSubagentThread({parentContext:ctx,onEvent:()=>{},agentId:"compact-child",storageCwd:cwd},
    {agentType:"Worker",cwd:childCwd,description:"bounded work",prompt:"KEEP_CHILD_DIRECTIVE",parentToolCallId:"spawn",contextSnapshot:{history:inherited}});
  await thread.run({prompt:"KEEP_CHILD_DIRECTIVE",signal:ctx.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
  await thread.run({prompt:"continue",signal:ctx.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
  expect(listSessionIndex(storage,cwd).map(s=>s.sessionId)).toEqual([ctx.sessionId]);
  expect(readLatestSessionSnapshot(storage,cwd,"subagent-compact-child")?.compactState?.compactCount).toBe(1);
  expect(loadSession(storage,cwd,"subagent-compact-child",ctx.model)).toBeNull();
  expect((await repairSessionIndex(storage,cwd)).sessions.map(s=>s.sessionId)).toEqual([ctx.sessionId]);
  await expect(ctx.sessionArchives.resolve(childIndex)).rejects.toThrow("another Session");
 });
});

test("worker coordination cannot displace the human request during Root compaction",async()=>withTempProject(async cwd=>{
 const ctx=createTestContext(cwd,{contextSettings:{windowTokens:8192,autoCompactTokenLimit:6000}});
 const history:Message[]=[{role:"system",content:"root"},{role:"user",origin:"user",content:"Never modify authentication."},
  ...Array.from({length:8},()=>({role:"assistant" as const,content:"evidence ".repeat(1000)})),
  ...Array.from({length:3},()=>({role:"user" as const,origin:"agent" as const,content:"worker finished"}))];
 const result=await createCompactHistoryRunner({generateSummary:async()=>"Progress summary"})({history,ctx,tools:[],preTokenCount:tokenCountWithEstimation(history),force:true});
 expect(result.message).toBeUndefined();
    expect(result.compacted).toBe(true);
 expect(history.some(m=>m.role==="user"&&m.origin==="user"&&m.content==="Never modify authentication.")).toBe(true);
}));
