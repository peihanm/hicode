import {expect,test} from "bun:test";
import {createAgentRunner} from "../../src/agent/index.js";
import {createCompactState} from "../../src/context/index.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createRootTurnRunnerFactory} from "../../src/runtime/turnRuntime.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";
import {withTempProject} from "../helpers/tempProject.js";
import {assistantText,createFakeLLM} from "../helpers/fakeLLM.js";
import {MemoryPublicationStore} from "../../src/memory/publicationStore.js";
for(const mode of ["success","save-failed","host-no-background","plan","ignore"] as const)test(`Root 仅在成功保存并允许后台后维护 ${mode}`,async()=>withTempProject(async(cwd,storage)=>{
 let calls=0;const memory=createTestMemoryRuntime(cwd,{autoExtract:true,extractor:{async extract(){calls++;return [];}}});
 const resources=createTestRuntimeResources(cwd,{memory});const fake=createFakeLLM([assistantText("完成")]);resources.agentRuntime.runAgent=createAgentRunner({callLLM:fake.callLLM,compactHistory:resources.agentRuntime.compactHistory});
 const session=createRootSessionRuntime({resources,allowBackgroundTasks:mode!=="host-no-background",seed:{sessionId:"root-memory",history:[{role:"system",content:"test"}],compactState:createCompactState()}});
 const runner=createRootTurnRunnerFactory(mode==="save-failed"?{saveSession:async()=>{throw new Error("disk-failed");}}:{});
 const run=runner({resources,session,prompt:mode==="ignore"?"忽略记忆":"完成任务",signal:new AbortController().signal,
  host:{canUseTool:async()=>({behavior:"allow"}),getPermissionRules:()=>({allow:[],deny:[],ask:[]}),getPermissionMode:()=>"ask",getCollaborationMode:()=>mode==="plan"?"plan":"build",getPermissionPromptPolicy:()=>"never",setTodos(){}},
  onEvent(){},onHookResult(){},onLifecycleIssue(){},getSnapshotState:()=>({todos:[],permissionMode:"ask",collaborationMode:mode==="plan"?"plan":"build",uiEvents:[]})});
 if(mode==="save-failed")await expect(run).rejects.toThrow("disk-failed");else await run;
 if(mode==="success"){
  const deadline=Date.now()+2000;while(session.taskSession.hasRunning()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  expect((await session.taskSession.list())[0]?.status).toBe("completed");expect(calls).toBe(1);expect(new MemoryPublicationStore(storage,cwd).snapshot().frames[0]?.status).toBe("no_output");
 }else{expect(calls).toBe(0);expect(await session.taskSession.list()).toHaveLength(0);}
 await resources.close();
}));
