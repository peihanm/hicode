import {expect,test} from "bun:test";
import {access,truncate,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {createDisabledSandboxRuntime} from "../helpers/sandbox.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
for(const name of ["image.png","font.woff2","large.txt"])test(`Bash removes only the authorized asset ${name} without inventing a file diff`,async()=>withTempProject(async cwd=>{
 const path=join(cwd,name);await writeFile(path,name==="large.txt"?Buffer.alloc(6*1024*1024,120):Buffer.from([0,255,128]));await writeFile(join(cwd,"keep.txt"),"keep");
 const ctx=createTestContext(cwd,{shellRunner:createShellRunner(createDisabledSandboxRuntime(),testChildEnvironment)});
 const metadata=await executeToolResult("read_file",JSON.stringify({path:name}),ctx,"read");expect(metadata.modelContent).toContain("SHA256");
 expect((await executeToolResult("write_file",JSON.stringify({path:name,content:"blind overwrite"}),ctx,"write")).outcome).toBe("failed");
 const deleted=await executeToolResult("bash",JSON.stringify({command:`rm -- '${name}'`}),ctx,"remove");expect(deleted.outcome).toBe("ok");expect(deleted.uiData).toBeUndefined();await expect(access(path)).rejects.toThrow();await access(join(cwd,"keep.txt"));
 expect((await executeToolResult("bash",JSON.stringify({command:`rm -- '${name}'`}),ctx,"again")).outcome).toBe("failed");
}));
test("oversized files remain unreadable without introducing deletion credentials",async()=>withTempProject(async cwd=>{
 const path=join(cwd,"oversized.bin");await writeFile(path,"");await truncate(path,20*1024*1024+1);const ctx=createTestContext(cwd);
 expect((await executeToolResult("read_file",JSON.stringify({path}),ctx,"read")).outcome).toBe("failed");await access(path);
}));
