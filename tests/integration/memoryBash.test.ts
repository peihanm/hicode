import {expect,test} from "bun:test";
import {join} from "node:path";
import {mkdir,readFile,writeFile,symlink,access} from "node:fs/promises";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime,remember,memoryOwner} from "../helpers/memory.js";
import {createTestContext} from "../helpers/testContext.js";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {executeDeliveredTool} from "../helpers/executeTool.js";
import {createSandboxRuntime} from "../../src/sandbox/runtime.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";

const enabled=process.platform==="darwin" && process.env.HICODE_RUN_SANDBOX_INTEGRATION==="1";
test.skipIf(!enabled)("Memory Bash deletes real files while protecting private state, siblings and network",async()=>withTempProject(async(cwd,storage)=>{
 const memory=createTestMemoryRuntime(cwd);const path=await remember(memory,"brief","可删除");const topics=join(memory.directory,"topics");
 const protectedFile=join(topics,"protected.txt");await writeFile(protectedFile,"protected");
 const secret=join(memory.directory,"private-sentinel.json");await writeFile(secret,"private");await writeFile(join(cwd,"outside.txt"),"outside");
 const sandbox=await createSandboxRuntime({cwd,storage,settings:{filesystem:{denyRead:[],denyWrite:[protectedFile]},network:{mode:"open",allowedDomains:[],allowLocalBinding:true}}});
 const runner=createShellRunner(sandbox,testChildEnvironment);const ctx=createTestContext(cwd,{shellRunner:runner,memoryFiles:memory.fileAccess(memoryOwner()),permissionMode:"ask"});const tools=createToolRuntime();let call=0;
 const run=(command:string,extra:object={})=>executeDeliveredTool(tools,"bash",JSON.stringify({command,cwd:topics,...extra}),ctx,`shell-${++call}`);
 try{
  expect(sandbox.status.kind).toBe("ready");
  expect((await run("rg --files")).modelContent).toContain("brief.md");
  const removed=await run("rm -- brief.md");expect(removed.modelContent).toBe("(no output)");expect(removed.outcome).toBe("ok");expect(removed.uiData).toBeUndefined();
  expect(await memory.read("brief")).toBeUndefined();await expect(access(path)).rejects.toThrow();
  expect((await run("printf 'human-readable memory' > created.md")).outcome).toBe("ok");expect((await memory.read("created"))?.content).toBe("human-readable memory");
  expect((await run("rm -- protected.txt")).outcome).toBe("failed");expect(await readFile(protectedFile,"utf8")).toBe("protected");
  expect((await run("cat ../private-sentinel.json")).outcome).toBe("denied");
  expect((await run("rm -- ../private-sentinel.json")).outcome).toBe("failed");
  expect((await run(`printf BAD > '${join(cwd,"outside.txt")}'`)).outcome).toBe("failed");
  await symlink(secret,join(topics,"alias"));expect((await run("cat alias")).outcome).toBe("denied");expect((await run("printf BAD > alias")).outcome).toBe("failed");
  expect((await run("true",{run_in_background:true})).outcome).toBe("denied");expect((await run("true",{sandbox_permissions:"require_escalated"})).outcome).toBe("denied");
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("reachable")});
  try{expect((await run(`echo test > /dev/tcp/127.0.0.1/${server.port}`)).outcome).toBe("failed");}finally{server.stop(true);}
  expect(await readFile(secret,"utf8")).toBe("private");expect(await readFile(join(cwd,"outside.txt"),"utf8")).toBe("outside");
  ctx.setCollaborationMode("plan");expect((await run("rm -- created.md")).outcome).toBe("denied");await access(join(topics,"created.md"));
  ctx.setCollaborationMode("build");ctx.permissionRules.deny.push({toolName:"bash",content:"rm:*",source:"local"});expect((await run("rm -- created.md")).outcome).toBe("denied");await access(join(topics,"created.md"));
  ctx.permissionRules.deny.length=0;ctx.memoryFiles=undefined;expect((await run("rm -- created.md")).outcome).toBe("denied");
 }finally{await sandbox.close();await memory.close();}
}),20000);

test.skipIf(!enabled)("maintenance draft Bash cannot touch parent runtime or project files",async()=>withTempProject(async(cwd,storage)=>{
 const draft=join(storage.hicodeHome,"draft");await mkdir(draft,{recursive:true});await writeFile(join(draft,"old.md"),"obsolete");await writeFile(join(cwd,"sentinel"),"keep");
 const sandbox=await createSandboxRuntime({cwd,storage,settings:{filesystem:{denyRead:[],denyWrite:[]},network:{mode:"open",allowedDomains:[],allowLocalBinding:false}}});
 const ctx=createTestContext(draft,{workspaceBoundary:draft,shellRunner:createShellRunner(sandbox,testChildEnvironment)});ctx.shellWorkspace=draft;const tools=createToolRuntime();
 try{
  expect((await executeDeliveredTool(tools,"bash",JSON.stringify({command:"rm -- old.md"}),ctx,"remove")).outcome).toBe("ok");
  expect((await executeDeliveredTool(tools,"bash",JSON.stringify({command:`cat '${join(cwd,"sentinel")}'`}),ctx,"read")).outcome).toBe("denied");
  expect((await executeDeliveredTool(tools,"bash",JSON.stringify({command:`rm -- '${join(cwd,"sentinel")}'`}),ctx,"outside")).outcome).toBe("failed");await access(join(cwd,"sentinel"));
 }finally{await sandbox.close();}
}),20000);
