import {expect,test} from "bun:test";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime,remember,memoryOwner} from "../helpers/memory.js";
test("pending note 立即召回，正式正文按需读取，忽略本轮收窄能力",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);await remember(memory,"brief","通过组合工厂注入 Fake");
 expect((await memory.contextForTurn("继续")).block).toContain("通过组合工厂注入 Fake");
 await memory.maintain(memoryOwner());const context=await memory.contextForTurn("继续");expect(context.block).toContain("views/MEMORY.md");expect(context.block).not.toContain("通过组合工厂注入 Fake");
 expect((await memory.contextForTurn("这次不要使用任何记忆")).ignoredForTurn).toBe(true);await memory.close();
}));
