import {executeToolResult} from "../helpers/executeTool.js";
import {createTestContext} from "../helpers/testContext.js";
import {saveSessionSnapshot} from "../helpers/sessionStorage.js";
import {expect,test} from "bun:test";
import {mkdir,writeFile,unlink} from "node:fs/promises";
import {join} from "node:path";
import {serializeMemoryTopic} from "../../src/memory/topic.js";
import {createTestMemoryRuntime,memoryOwner,remember} from "../helpers/memory.js";
import {withTempProject} from "../helpers/tempProject.js";
test("unpublished extraction is not recalled as a second copy of Memory",async()=>withTempProject(async(cwd,storage)=>{
 const memory=createTestMemoryRuntime(cwd,{autoExtract:true,extractor:{async extract(messages){return [{key:"unverified",type:"project",basis:"assistant-claimed",sources:[messages.find(m=>m.role==="assistant")!.id],content:"助手称部署成功，未独立验证"}];}},consolidator:{async consolidate(){throw new Error("offline failure");}}});
 await saveSessionSnapshot(storage,{cwd,sessionId:"evidence",model:"glm-test",history:[{role:"user",origin:"user",content:"结果如何"},{role:"assistant",content:"部署成功"}],todos:[],permissionMode:"ask",collaborationMode:"build",uiEvents:[]});
 await memory.captureSource("evidence",[],memoryOwner().signal);await expect(memory.maintain(memoryOwner())).rejects.toThrow("offline failure");
 expect((await memory.contextForTurn("继续")).block).not.toContain("部署成功");expect(await memory.read("unverified")).toBeUndefined();expect((await memory.status()).pending).toBe(1);
 await memory.close();
}));
test("manual deletion is reflected immediately; reopening cannot reconstruct the file",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);const path=await remember(memory,"brief","保持简洁");await unlink(path);
 expect(await memory.read("brief")).toBeUndefined();expect((await memory.contextForTurn("继续")).block).not.toContain("brief.md");await memory.close();
 const reopened=createTestMemoryRuntime(cwd);expect((await reopened.list()).entries).toEqual([]);await reopened.close();
}));
test("explicit file notifications remain Session/Turn scoped; legacy Markdown is ignored",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);await mkdir(memory.directory,{recursive:true});await writeFile(join(memory.directory,"legacy.md"),"旧版私有正文");expect((await memory.contextForTurn("继续")).block).not.toContain("旧版私有正文");
 const a=memoryOwner(),b={...memoryOwner(),sessionId:"other"};const revision=memory.getRevision();
 for(const [owner,key] of [[a,"a"],[b,"b"]] as const)expect((await executeToolResult("write_file",JSON.stringify({path:join(memory.directory,`topics/${key}.md`),content:serializeMemoryTopic({name:key,description:"Saved",type:"feedback",content:key})}),createTestContext(cwd,{memoryFiles:memory.fileAccess(owner)}),`write-${key}`)).outcome).toBe("ok");
 expect(memory.explicitChangesSince(revision,a).map(change=>change.key)).toEqual(["a"]);expect(memory.explicitChangesSince(revision,b).map(change=>change.key)).toEqual(["b"]);await memory.close();
}));
