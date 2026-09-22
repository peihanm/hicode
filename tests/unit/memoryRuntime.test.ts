import {expect,test} from "bun:test";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime,queueMemory,memoryOwner} from "../helpers/memory.js";
test("无增量与关闭不启动模型，显式维护一次发布并消费",async()=>withTempProject(async cwd=>{
 let calls=0;
 const memory=createTestMemoryRuntime(cwd,{autoExtract:true,consolidator:{async consolidate({lease,baseline}){calls++;return {summary:"简洁",topics:baseline.sources.filter(s=>lease.sourceIds.includes(s.id)).map(s=>({key:s.key,name:s.key,description:"回答风格",type:s.type,content:s.content,sources:[s.id]}))};}}});
 expect((await memory.maintain(memoryOwner())).status).toBe("empty");
 await queueMemory(cwd,"brief","保持简洁");
 expect((await memory.contextForTurn("继续")).block).not.toContain("保持简洁");
 expect((await memory.status()).pending).toBe(1);
 expect((await memory.maintain(memoryOwner())).status).toBe("published");
 expect((await memory.status()).pending).toBe(0);
 await memory.maintain(memoryOwner());await memory.close();expect(calls).toBe(1);
}));
test("调用方取消当前整理，不发布半成品",async()=>withTempProject(async cwd=>{
 let started!:()=>void;const ready=new Promise<void>(r=>started=r);
 const memory=createTestMemoryRuntime(cwd,{consolidator:{async consolidate({signal}){started();await new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true}));throw new Error("unreachable");}}});
 await queueMemory(cwd,"brief","保持简洁");const controller=new AbortController();const job=memory.maintain({sessionId:"test",signal:controller.signal});const failed=job.catch(error => error);await ready;controller.abort();await memory.close();expect(await failed).toBeInstanceOf(Error);expect((await memory.status()).pending).toBe(1);expect((await memory.status()).published).toBe(0);
}));

test("整理期间新增 note 自动进入下一批，总调用次数有界", async () => withTempProject(async cwd => {
    let started!: () => void;
    let proceed!: () => void;
    const ready = new Promise<void>(resolve => {started = resolve;});
    const continueWork = new Promise<void>(resolve => {proceed = resolve;});
    let calls = 0;
    const memory = createTestMemoryRuntime(cwd, {consolidator: {async consolidate({baseline, lease}) {
        calls++;
        if (calls === 1) {started(); await continueWork;}
        return {summary: "notes", topics: [...baseline.topics.map(({createdAt: _created, updatedAt: _updated, ...topic}) => topic), ...baseline.sources.filter(source => lease.sourceIds.includes(source.id)).map(source => ({
            key: source.key, name: source.key, description: "note", type: source.type, content: source.content, sources: [source.id],
        }))]};
    }}});
    try {
        await queueMemory(cwd, "first", "first note");
        const work = memory.maintain(memoryOwner());
        await ready;
        await queueMemory(cwd, "second", "second note");
        proceed();
        expect((await work).status).toBe("published");
        expect(calls).toBe(2);
        expect((await memory.status()).pending).toBe(0);
        expect((await memory.status()).published).toBe(2);
    } finally {proceed(); await memory.close();}
}));

test("持续追加最多处理四批，剩余来源保持 pending", async () => withTempProject(async cwd => {
    let calls = 0;
    const memory = createTestMemoryRuntime(cwd, {consolidator: {async consolidate({baseline, lease}) {
        calls++;
        await queueMemory(cwd, `next-${calls}`, `note ${calls}`);
        return {summary: "bounded", topics: [
            ...baseline.topics.map(({createdAt: _created, updatedAt: _updated, ...topic}) => topic),
            ...baseline.sources.filter(source => lease.sourceIds.includes(source.id)).map(source => ({key: source.key,
                name: source.key, description: "note", type: source.type, content: source.content, sources: [source.id]})),
        ]};
    }}});
    try {
        await queueMemory(cwd, "first", "first");
        expect((await memory.maintain(memoryOwner())).status).toBe("published");
        expect(calls).toBe(4);
        expect((await memory.status()).pending).toBe(1);
    } finally {await memory.close();}
}));
