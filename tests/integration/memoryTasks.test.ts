import {expect,test} from "bun:test";
import {join} from "node:path";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestMemoryRuntime,remember,memoryOwner} from "../helpers/memory.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {withTempProject} from "../helpers/tempProject.js";

test("Memory Task 具有真实 Turn owner；Host 禁后台无模型，关闭取消并可恢复状态",async()=>withTempProject(async cwd=>{
 let calls=0;let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
 const memory=createTestMemoryRuntime(cwd,{consolidator:{async consolidate({signal}){calls++;started();await new Promise<void>((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true}));throw new Error("unreachable");}}});
 await remember(memory,"brief","保持简洁");const shell=createShellRunner(createDisabledSandboxRuntime(),testChildEnvironment);const home=join(cwd,"tasks-storage");
 const tasks=createTaskRuntimeForTest(cwd,shell,undefined,home,undefined,memory);const binding={sessionId:"owner",toolResultStore:createTestToolResultStore(cwd,"owner")};
 expect(await tasks.forSession({...binding,allowBackgroundTasks:false}).startMemory({turnId:"turn",signal:memoryOwner().signal,background:true})).toBeUndefined();expect(calls).toBe(0);
 const session=tasks.forSession(binding);const job=await session.startMemory({turnId:"turn",signal:memoryOwner().signal,background:true});expect(job?.owner).toEqual({sessionId:"owner",turnId:"turn"});await ready;
 expect(tasks.getRunningSummary().memory).toBe(1);await tasks.close();expect((await session.get(job!.id))?.status).toBe("cancelled");expect((await memory.status()).pending).toBe(1);
 const restored=createTaskRuntimeForTest(cwd,shell,undefined,home,undefined,memory);const restoredSession=restored.forSession(binding);expect((await restoredSession.get(job!.id))?.kind).toBe("memory");const notes=await restoredSession.pendingNotifications();expect(notes[0]?.ownerToolCallId).toBeUndefined();expect(notes[0]?.kind).toBe("memory");await restored.close();await memory.close();expect(calls).toBe(1);
}));
test("显式前台维护在禁后台 Host 仍可等待完成，停止后不会作为 Agent 接收消息",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);await remember(memory,"brief","简洁");const tasks=createTaskRuntimeForTest(cwd,createShellRunner(createDisabledSandboxRuntime(),testChildEnvironment),undefined,join(cwd,"tasks"),undefined,memory);const session=tasks.forSession({sessionId:"owner",toolResultStore:createTestToolResultStore(cwd,"owner"),allowBackgroundTasks:false});
 const job=await session.startMemory({turnId:"turn",signal:memoryOwner().signal,background:false});expect(job?.status).toBe("completed");expect((await memory.status()).published).toBe(1);expect(await session.pendingNotifications()).toHaveLength(0);await expect(session.send(job!.id,"继续")).rejects.toThrow("不是 Agent");await tasks.close();await memory.close();
}));
