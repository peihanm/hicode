import {expect,test} from "bun:test";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime,remember,memoryOwner} from "../helpers/memory.js";
test("pending note 立即召回，正式正文按需读取，忽略本轮收窄能力",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);await remember(memory,"brief","通过组合工厂注入 Fake");
 expect((await memory.contextForTurn("继续")).block).toContain("topics/brief.md");
 expect((await memory.read("brief"))?.content).toBe("通过组合工厂注入 Fake");
 await memory.maintain(memoryOwner());const context=await memory.contextForTurn("继续");expect(context.block).toContain("MEMORY.md");expect(context.block).not.toContain("通过组合工厂注入 Fake");
 expect((await memory.contextForTurn("这次不要使用任何记忆")).ignoredForTurn).toBe(true);await memory.close();
}));

test("Memory prompt provides usable absolute write paths, including spaces and escaped tags", async () => withTempProject(async root => {
 const {join,isAbsolute} = await import("node:path");
 const {mkdir,readFile,access} = await import("node:fs/promises");
 const {createTestContext} = await import("../helpers/testContext.js");
 const {createToolRuntime} = await import("../../src/tools/runtime.js");
 const cwd=join(root,"project space <scope>");await mkdir(cwd);
 const memory=createTestMemoryRuntime(cwd);
 try {
  const block=(await memory.contextForTurn("remember this")).block!;
  expect(block).toContain("Use absolute paths");
  expect(block).toContain("Do not pass topics/<key>.md as a relative path");
  expect(block).not.toContain("<scope>");
  const sample=block.split("\n").find(line=>line.startsWith("Example write_file arguments"))!;
  const args=JSON.parse(sample.slice(sample.indexOf(": ")+2));
  expect(isAbsolute(args.path)).toBe(true);
  expect(args.path).toBe(join(memory.directory,"topics","response-style.md"));
  const ctx=createTestContext(cwd);ctx.memoryFiles=memory.fileAccess(ctx);
  expect((await createToolRuntime().executeTool("write_file",JSON.stringify({...args,content:"Fixture preference"}),ctx,"save-memory")).outcome).toBe("ok");
  expect(await readFile(args.path,"utf8")).toBe("Fixture preference");
  await expect(access(join(cwd,"topics"))).rejects.toThrow();
 } finally {await memory.close();}
}));
