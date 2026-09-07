import {expect,test} from "bun:test";
import {join} from "node:path";
import {createToolRuntime} from "../../src/tools/runtime.js";
import {executeDeliveredTool} from "../helpers/executeTool.js";
import {createTestMemoryRuntime,memoryOwner} from "../helpers/memory.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
test("note 具体格式错误可修复，私有文件和正式索引不能写，重读后纠正立即生效",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);let prompts=0;const ctx=createTestContext(cwd,{permissionMode:"default",memoryFiles:memory.fileAccess(memoryOwner()),canUseTool:async()=>{prompts++;return {behavior:"deny",message:"unexpected"};}});const tools=createToolRuntime();let call=0;const execute=(name:string,input:object)=>executeDeliveredTool(tools,name,JSON.stringify(input),ctx,`note-${++call}`);const path=join(memory.directory,"inbox/brief.md");
 const bad=await execute("write_file",{path,content:"---\noperation: remember\n---\n简洁"});expect(bad.outcome).toBe("failed");expect(bad.modelContent).toContain("type");
 expect((await execute("write_file",{path,content:"---\noperation: remember\ntype: feedback\n---\n简洁"})).outcome).toBe("ok");
 expect((await execute("write_file",{path:join(memory.directory,"publication.json"),content:"{}"})).outcome).toBe("denied");
 expect((await execute("write_file",{path:join(memory.directory,"views/MEMORY.md"),content:"假的"})).outcome).toBe("denied");
 expect((await execute("read_file",{path})).outcome).toBe("ok");
 expect((await execute("edit_file",{path,edits:[{old_string:"operation: remember",new_string:"operation: correct"},{old_string:"简洁",new_string:"详细"}]})).outcome).toBe("ok");
 expect((await memory.contextForTurn("继续")).block).toContain("详细");expect((await memory.contextForTurn("继续")).block).not.toContain('"content":"简洁"');
 expect((await execute("read_file",{path})).outcome).toBe("ok");expect((await execute("delete_file",{path})).outcome).toBe("ok");expect(await memory.read("brief")).toBeUndefined();expect(prompts).toBe(0);await memory.close();
}));
