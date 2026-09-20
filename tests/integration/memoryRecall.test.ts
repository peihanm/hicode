import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import {expect,test} from "bun:test";
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";

import {serializeMemoryNote} from "../../src/memory/note.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {createTestMemoryRuntime,memoryOwner} from "../helpers/memory.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeDeliveredTool} from "../helpers/executeTool.js";
test("自动 pending 可经普通 Read/Grep 读取，保留助手声称类别；忘记后不能读旧缓存",async()=>withTempProject(async(cwd,storage)=>{
 const memory=createTestMemoryRuntime(cwd,{autoExtract:true,extractor:{async extract(messages){return [{key:"unverified",type:"project",basis:"assistant-claimed",sources:[messages.find(m=>m.role==="assistant")!.id],content:"助手称部署成功，未独立验证"}];}},consolidator:{async consolidate(){throw new Error("offline failure");}}});
 await saveSessionSnapshot(storage,{cwd,sessionId:"evidence",model:"glm-test",history:[{role:"user", origin: "user" as const,content:"结果如何"},{role:"assistant",content:"部署成功"}],todos:[],permissionMode:"ask",collaborationMode:"build",uiEvents:[]});
 await memory.captureSource("evidence",[],memoryOwner().signal);await expect(memory.maintain(memoryOwner())).rejects.toThrow("offline failure");
 const context=await memory.contextForTurn("继续");expect(context.block).toContain("assistant-claimed");const entry=(await memory.read("unverified"))!;expect(entry.path).toContain("views/unverified.md");
 const tools=createToolRuntime();const ctx=createTestContext(cwd,{memoryFiles:memory.fileAccess(memoryOwner())});const execute=(name:string,input:object,id:string)=>executeDeliveredTool(tools,name,JSON.stringify(input),ctx,id);
 const read=await execute("read_file",{path:entry.path},"read");expect(read.outcome).toBe("ok");expect(read.modelContent).toContain("assistant-claimed");expect((await execute("bash",{command:`rg -n -e 未独立验证 '${entry.path}'`},"grep")).modelContent).toContain("未独立验证");
 const indexPath=join(memory.directory,"views/MEMORY.md"); await expect(readFile(indexPath,"utf8")).rejects.toThrow();
 expect((await execute("read_file",{path:indexPath},"index")).modelContent).toContain("unverified");
 await memory.forget("unverified",memoryOwner().signal);await writeFile(entry.path,"被忘记的旧缓存");const stale=await execute("read_file",{path:entry.path},"stale");expect(stale.outcome).toBe("denied");expect(stale.modelContent).not.toContain("被忘记的旧缓存");await memory.close();
}));
test("显式变更通知按 Session/Turn 过滤，旧格式不参与召回",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);await mkdir(memory.directory,{recursive:true});await writeFile(join(memory.directory,"legacy.md"),"旧版私有正文");const context=await memory.contextForTurn("继续");expect(context.block).not.toContain("旧版 Memory");expect(context.block).not.toContain("旧版私有正文");
 const a=memoryOwner(),b={...memoryOwner(),sessionId:"other"};const revision=memory.getRevision();
 await memory.fileAccess(a).write(join(memory.directory,"inbox/a.md"),serializeMemoryNote({operation:"remember",type:"feedback",content:"A"}),null,"write-a");
 await memory.fileAccess(b).write(join(memory.directory,"inbox/b.md"),serializeMemoryNote({operation:"remember",type:"feedback",content:"B"}),null,"write-b");
 expect(memory.explicitChangesSince(revision,a).map(change=>change.key)).toEqual(["a"]);expect(memory.explicitChangesSince(revision,b).map(change=>change.key)).toEqual(["b"]);await memory.close();
}));
