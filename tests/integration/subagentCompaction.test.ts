import {expect, test} from "bun:test";
import {mkdir, readdir} from "node:fs/promises";
import {getSubagentStorageDirectory, getProjectSessionsDirectory} from "../../src/persistence/layout.js";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createSubagentFactories} from "../../src/subagents/runSubagent.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {createToolResultStore} from "../../src/toolResults/store.js";
import {readLatestSessionSnapshot} from "../../src/session/store/snapshotStore.js";
import {createSessionPersistence, listSessionIndex, loadSession} from "../../src/session/store/sessionStore.js";
import {createSessionArchiveAccess, prepareSessionArchive} from "../../src/session/archive.js";
import {createCompactState} from "../../src/context/state.js";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {selectCompactInput} from "../../src/context/selection.js";
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
    history:inherited,compactState:parentState,todos:[],permissionMode:"ask",allowEmpty:true},draft,ctx.signal);
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
  const factory=createSubagentFactories({primaryRunAgent:runner,registry:BUILTIN_SUBAGENT_REGISTRY,
    createToolResultStore:(cwd,id)=>createToolResultStore(storage,cwd,id)});
  const thread=factory.createSubagentThread({parentContext:ctx,onEvent:()=>{},agentId:"compact-child",storageCwd:cwd},
    {agentType:"Worker",cwd:childCwd,description:"bounded work",prompt:"KEEP_CHILD_DIRECTIVE",parentToolCallId:"spawn",contextSnapshot:{history:inherited}});
  await thread.run({prompt:"KEEP_CHILD_DIRECTIVE",signal:ctx.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
  await thread.run({prompt:"continue",signal:ctx.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
  expect(listSessionIndex(storage,cwd).map(s=>s.sessionId)).toEqual([ctx.sessionId]);
  expect(readLatestSessionSnapshot(storage,cwd,{parentSessionId:ctx.sessionId,agentId:"compact-child"})?.compactState?.compactCount).toBe(1);
  expect(await readdir(getSubagentStorageDirectory(storage,cwd,ctx.sessionId,"compact-child")))
    .toEqual(expect.arrayContaining(["identity.json","snapshot.json","content","archives","events.jsonl","state.json"]));
  expect((await readdir(getProjectSessionsDirectory(storage,cwd))).filter(name=>name.startsWith("session-"))).toHaveLength(1);
  expect(loadSession(storage,cwd,"subagent-compact-child")).toBeNull();
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

test("child 自动补回使用自己的 cwd/Scoped Runtime 并重验父权限，不获得额外工具", async () => {
 await withTempProject(async (cwd, storage) => {
  const {writeFile} = await import("node:fs/promises");
  const parent = createTestContext(cwd, {toolNames: ["read_file"]});
  const childCwd = join(cwd, "child");
  await mkdir(childCwd);
  await writeFile(join(childCwd, "source.ts"), "child source\n");
  await writeFile(join(cwd, "source.ts"), "parent source\n");
  const events: import("../../src/agent/types.js").AgentEvent[] = [];
  const runner: AgentRunner = async (_prompt, history, _onEvent, child, _channel, options) => {
   const call = {id:"initial-read",type:"function" as const,function:{name:"read_file",arguments:'{"path":"source.ts"}'}};
   const read = await options.executeTool("read_file",call.function.arguments,child,call.id);
   if (typeof read === "string") throw new Error("Expected structured execution");
   expect(read.modelContent).toContain("child source");
   expect(read.modelContent).not.toContain("parent source");
   const previous: Message[] = [...history,{role:"assistant",content:null,tool_calls:[call]},
    {role:"tool",tool_call_id:call.id,content:read.modelContent}];
   await child.restoreAfterCompaction!(previous,history,()=>true);
   expect(history.at(-1)?.content).toContain("child source");
   const last = history.at(-2);
   expect(last?.role === "assistant" && last.tool_calls?.[0]?.function.arguments).toContain(childCwd);
   expect(child.availableTools.map(tool=>tool.name)).toEqual(["read_file"]);
   parent.permissionRules.deny.push({toolName:"read_file",source:"host"});
   const denied: Message[] = [history[0]!];
   await child.restoreAfterCompaction!(previous,denied,()=>true);
   expect(denied.at(-1)?.content).toContain("Permission denied");
   return {reason:"completed",reply:"done",iterations:1};
  };
  const factory=createSubagentFactories({primaryRunAgent:runner,registry:BUILTIN_SUBAGENT_REGISTRY,
   createToolResultStore:(cwd,id)=>createToolResultStore(storage,cwd,id)});
  const thread=factory.createSubagentThread({parentContext:parent,onEvent:event=>{events.push(event);},agentId:"restore-child",storageCwd:cwd},
   {agentType:"Worker",cwd:childCwd,description:"read child source",prompt:"Read source",parentToolCallId:"spawn"});
  try {
   await thread.run({prompt:"Read source",signal:parent.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
   expect(events.some(event=>event.type==="subagent_progress" && event.event.type==="tool_start")).toBe(true);
  } finally {await thread.close();}
 });
});
