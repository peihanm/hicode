import {expect,test} from "bun:test";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime,remember,memoryOwner} from "../helpers/memory.js";
test("公开主题与私有状态分离，索引不能写，格式错误不修改正文",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);const access=memory.fileAccess(memoryOwner());
 expect(access.classify(join(memory.directory,"state.json"))).toBeUndefined();
 expect(access.classify(join(cwd,"outside.md"))).toBeUndefined();
 await expect(access.prepare(join(memory.directory,"MEMORY.md"),"write_file")).rejects.toThrow("index");
 const path=await remember(memory,"brief","简洁");
 expect(()=>access.validateWrite(path,"---\noperation: remember\ntype: user\n---\n不同正文")).toThrow();
 expect((await memory.read("brief"))?.content).toBe("简洁");await memory.close();
}));
