import {contentText} from "../../src/images/content.js";
import {expect,test} from "bun:test";
import {readFile} from "node:fs/promises";
import {z} from "zod";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createCompactState} from "../../src/context/state.js";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {createCompactSummaryGenerator} from "../../src/context/compactSummary.js";
import {createFakeLLM,assistantText} from "../helpers/fakeLLM.js";
import {loadSession} from "../../src/session/storage.js";
import {readArchiveMessages} from "../../src/session/archive.js";
import {SessionContentStore} from "../../src/session/contentStore.js";
import {archiveIndexPath} from "../../src/session/archiveAccess.js";
import {hasCompleteToolPairs} from "../../src/session/codec.js";
const scenarios=z.array(z.object({id:z.string(),goal:z.string(),stages:z.array(z.object({request:z.string(),evidence:z.string(),constraint:z.string()})).length(5)})).length(2)
 .parse(JSON.parse(await readFile(new URL("../../tooling/evals/fixtures/context-memory/scenarios.json",import.meta.url),"utf8")));
// The summarizer is a deterministic oracle. This verifies evidence transport, not model understanding.
for(const scenario of scenarios)test(`固定场景五次交接后仍能回查全部纠正与验证证据 ${scenario.id}`,async()=>withTempProject(async(cwd,storage)=>{
 const resources=createTestRuntimeResources(cwd,{storage});
 const state=()=>({todos:[],uiEvents:[],permissionMode:"default" as const,collaborationMode:"build" as const});
 const session=createRootSessionRuntime({resources,resumed:false,seed:{sessionId:scenario.id,history:[{role:"system",content:"test"},{role:"user",content:scenario.goal}],compactState:createCompactState()}});
 const ctx=session.createContext({signal:new AbortController().signal,onEvent(){},getSnapshotState:state,host:{canUseTool:async()=>({behavior:"deny",message:"offline"}),getPermissionRules:()=>({allow:[],deny:[],ask:[]}),getPermissionMode:()=>"default",getCollaborationMode:()=>"build",getPermissionPromptPolicy:()=>"never",setPermissionMode(){},setCollaborationMode(){},setTodos(){}}});
 const fake=createFakeLLM(scenario.stages.map(stage=>input=>{
  const message=input.messages.findLast(message=>message.role==="user"&&contentText(message.content).includes(stage.request));
  const source=contentText(message?.content).match(/\[source ([a-f0-9]{64}\/\d+);/)?.[1];if(!source)throw new Error("fixture source missing");
  return assistantText(JSON.stringify({version:1,objective:[],constraints:[{text:stage.constraint,sources:[source],basis:"reported"}],decisions:[],files:[],verification:[],next:[]}));
 }));
 const compact=createCompactHistoryRunner({generateSummary:createCompactSummaryGenerator({callLLM:fake.callLLM})});
 try{
  for(const [round,stage] of scenario.stages.entries()){
   session.history.push({role:"user",content:stage.request},{role:"assistant",content:null,tool_calls:[{id:`evidence-${round}`,type:"function",function:{name:"bash",arguments:JSON.stringify({command:`offline-evidence-${round}`})}}]},
    {role:"tool",tool_call_id:`evidence-${round}`,content:stage.evidence},{role:"assistant",content:"中间检索资料\n".repeat(4000)});
   expect((await compact({history:session.history,ctx,tools:[],preTokenCount:100_000,force:true})).compacted).toBe(true);
   expect(session.history[1]?.content).toContain(stage.constraint);
  }
  const restored=loadSession(storage,cwd,scenario.id,"glm-test")!;expect(restored.compactState?.compactCount).toBe(5);
  const archives=restored.compactState!.archives!;const store=new SessionContentStore(storage,cwd,scenario.id);
  const originals=archives.flatMap(archive=>{const messages=readArchiveMessages(archive,store);expect(hasCompleteToolPairs(messages)).toBe(true);return messages;});
  for(const stage of scenario.stages){expect(originals.some(message=>message.role==="user"&&message.content===stage.request)).toBe(true);expect(originals.some(message=>message.role==="tool"&&message.content===stage.evidence)).toBe(true);}
  const result=await resources.toolRuntime.executeTool("read_file",JSON.stringify({path:archiveIndexPath(storage,cwd,scenario.id,archives[0]!.id)}),ctx,"read-first-evidence");expect(result.outcome).toBe("ok");expect(fake.calls).toHaveLength(5);expect(fake.calls.every(call=>call.tools.length===0&&call.kind==="compact")).toBe(true);
 }finally{await resources.close();}
}));
