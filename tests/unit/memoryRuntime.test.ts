import {expect,test} from "bun:test";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime,remember,memoryOwner} from "../helpers/memory.js";
test("无增量与关闭不启动模型，显式维护一次发布并消费",async()=>withTempProject(async cwd=>{
 let calls=0;
 const memory=createTestMemoryRuntime(cwd,{autoExtract:true,consolidator:{async consolidate({lease,baseline}){calls++;return {summary:"简洁",topics:baseline.sources.filter(s=>lease.sourceIds.includes(s.id)).map(s=>({key:s.key,name:s.key,description:"回答风格",type:s.type,content:s.content,sources:[s.id]}))};}}});
 expect((await memory.maintain(memoryOwner())).status).toBe("empty");
 await remember(memory,"brief","保持简洁");
 expect((await memory.contextForTurn("继续")).block).toContain("保持简洁");
 expect((await memory.status()).pending).toBe(1);
 expect((await memory.maintain(memoryOwner())).status).toBe("published");
 expect((await memory.status()).pending).toBe(0);
 await memory.maintain(memoryOwner());await memory.close();expect(calls).toBe(1);
}));
test("关闭取消当前整理，不发布半成品或继续 drain",async()=>withTempProject(async cwd=>{
 let started!:()=>void;const ready=new Promise<void>(r=>started=r);
 const memory=createTestMemoryRuntime(cwd,{consolidator:{async consolidate({signal}){started();await new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true}));throw new Error("unreachable");}}});
 await remember(memory,"brief","保持简洁");const job=memory.maintain(memoryOwner());const failed=job.catch(error => error);await ready;await memory.close();expect(await failed).toBeInstanceOf(Error);expect((await memory.status()).pending).toBe(1);expect((await memory.status()).published).toBe(0);
}));
