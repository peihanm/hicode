import {expect,test} from "bun:test";
import {saveSessionSnapshot} from "../../src/session/storage.js";
import {readSessionSourceIds,readSessionSourceMessages} from "../../src/session/snapshotStore.js";
import {MemoryPublicationStore} from "../../src/memory/publicationStore.js";
import {createMemorySourceExtractorFactory} from "../../src/memory/sourceExtractor.js";
import {createFakeLLM,assistantText} from "../helpers/fakeLLM.js";
import {createTestMemoryRuntime,memoryOwner} from "../helpers/memory.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {Message} from "../../src/llm/types.js";

async function persist(storage:Parameters<typeof saveSessionSnapshot>[0],cwd:string,history:Message[]) {
 await saveSessionSnapshot(storage,{cwd,sessionId:"source-session",model:"glm-test",history,todos:[],permissionMode:"default",collaborationMode:"build",uiEvents:[]});
}
test("只提取成功保存的新消息，no_output 持久消费且不重复调用",async()=>withTempProject(async(cwd,storage)=>{
 let calls=0;const memory=createTestMemoryRuntime(cwd,{autoExtract:true,extractor:{async extract(messages){calls++;expect(messages.some(m=>m.content==="旧输入")).toBe(false);return [];}}});
 await persist(storage,cwd,[{role:"user",content:"旧输入"},{role:"assistant",content:"旧回答"}]);const baseline=await memory.captureBaseline("source-session","继续");
 await persist(storage,cwd,[{role:"user",content:"旧输入"},{role:"assistant",content:"旧回答"},{role:"user",content:"今日天气"},{role:"assistant",content:"不知道"}]);
 await memory.captureSource("source-session",baseline!,memoryOwner().signal);await memory.maintain(memoryOwner());await memory.captureSource("source-session",baseline!,memoryOwner().signal);await memory.maintain(memoryOwner());
 expect(calls).toBe(1);const state=new MemoryPublicationStore(storage,cwd).snapshot();expect(state.frames[0]?.status).toBe("no_output");expect(state.sources).toHaveLength(0);await memory.close();
}));
test("提取事实保留角色来源，阶段二发布；忘记后同一 frame 不复活",async()=>withTempProject(async(cwd,storage)=>{
 const memory=createTestMemoryRuntime(cwd,{autoExtract:true,extractor:{async extract(messages){return [{key:"brief",type:"feedback",content:"保持简洁",basis:"user-stated",sources:[messages.find(m=>m.role==="user")!.id]}];}}});
 await persist(storage,cwd,[{role:"user",content:"以后保持简洁"},{role:"assistant",content:"明白"}]);await memory.captureSource("source-session",[],memoryOwner().signal);await memory.maintain(memoryOwner());
 expect((await memory.read("brief"))?.content).toBe("保持简洁");expect(new MemoryPublicationStore(storage,cwd).snapshot().sources[0]?.origin.kind).toBe("session");
 await memory.forget("brief",memoryOwner().signal);await memory.captureSource("source-session",[],memoryOwner().signal);expect((await memory.maintain(memoryOwner())).status).toBe("empty");expect(await memory.read("brief")).toBeUndefined();await memory.close();
}));
test("来源已从当前分支移除则提取失败，不消费或发布",async()=>withTempProject(async(cwd,storage)=>{
 const memory=createTestMemoryRuntime(cwd,{autoExtract:true});await persist(storage,cwd,[{role:"user",content:"旧分支"}]);const hashes=readSessionSourceIds(storage,cwd,"source-session");await memory.captureSource("source-session",[],memoryOwner().signal);
 await persist(storage,cwd,[{role:"user",content:"新分支"}]);expect(()=>readSessionSourceMessages(storage,cwd,"source-session",hashes)).toThrow("当前 Session 分支");await expect(memory.maintain(memoryOwner())).rejects.toThrow("当前 Session 分支");expect(new MemoryPublicationStore(storage,cwd).snapshot().frames[0]?.status).toBe("pending");await memory.close();
}));
test("阶段一无工具，伪造来源或把助手声称升级为工具观察均拒绝",async()=>withTempProject(async(cwd,storage)=>{
 const hash="a".repeat(64);const fake=createFakeLLM([assistantText(JSON.stringify({facts:[{key:"result",type:"project",content:"测试通过",basis:"tool-observed",sources:[hash]}]}))]);
 const extractor=createMemorySourceExtractorFactory(fake.callLLM)({cwd,storage,target:{source:"glm",provider:"glm",model:"glm-test",label:"GLM"},source:{id:"glm",label:"GLM",apiKeyEnv:"GLM_API_KEY"}});
 await expect(extractor.extract([{id:hash,role:"assistant",content:"测试通过"}],memoryOwner().signal)).rejects.toThrow("证据类别");expect(fake.calls[0]?.tools).toHaveLength(0);
}));
