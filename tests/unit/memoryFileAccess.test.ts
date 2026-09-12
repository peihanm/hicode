import {expect,test} from "bun:test";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime,remember,memoryOwner} from "../helpers/memory.js";
test("公开视图与私有状态分离，正式内容只读，重复工具来源幂等",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);const access=memory.fileAccess(memoryOwner());
 expect(access.classify(join(memory.directory,"publication.json"))).toBeUndefined();
 expect(access.classify(join(cwd,"outside.md"))).toBeUndefined();
 await expect(access.prepare(join(memory.directory,"views/MEMORY.md"),"write_file")).rejects.toThrow("read-only");
 const path=await remember(memory,"brief","简洁");
 await expect(access.write(path,"---\noperation: remember\ntype: user\n---\n不同正文",null,"another-call")).rejects.toThrow();
 expect((await memory.read("brief"))?.content).toBe("简洁");await memory.close();
}));
