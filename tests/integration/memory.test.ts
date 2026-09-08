import {contentText} from "../../src/images/content.js";
import {expect,test} from "bun:test";
import {join} from "node:path";
import {createAgentRunner,EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/index.js";
import {createMemoryAwareAgentRunner} from "../../src/memory/runtime.js";
import {serializeMemoryNote} from "../../src/memory/note.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import {assistantText,assistantToolCall,createFakeLLM} from "../helpers/fakeLLM.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";
const noCompact=async({preTokenCount}:{preTokenCount:number})=>({compacted:false as const,preTokenCount,threshold:1_000_000});
test("Root 使用标准工具单次接收 note，下一轮直接召回，不维护索引",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);const path=join(memory.directory,"inbox","brief.md");
 const fake=createFakeLLM([assistantToolCall("write_file",{path,content:serializeMemoryNote({operation:"remember",type:"feedback",content:"保持简洁"})},"note"),assistantText("已记住")]);
 const root=createMemoryAwareAgentRunner(createAgentRunner({callLLM:fake.callLLM,compactHistory:noCompact}),memory);const tools=createToolRuntime();const events:string[]=[];
 const result=await root("请记住保持简洁",createInitialHistory(cwd,"glm-test"),event=>{events.push(event.type);},(()=>{const ctx=createTestContext(cwd);ctx.memoryFiles=memory.fileAccess(ctx);return ctx;})(),EMPTY_AGENT_INPUT_CHANNEL,{getToolSchemas:tools.getToolSchemas,executeTool:tools.executeTool,isToolConcurrencySafe:tools.isConcurrencySafe});
 expect(fake.calls[1]?.messages.some(message=>message.role==="user"&&contentText(message.content).includes('"content":"保持简洁"'))).toBe(true);expect(result.reason).toBe("completed");expect(events).toContain("memory_update");expect((await memory.contextForTurn("继续")).block).toContain("保持简洁");expect((await memory.status()).pending).toBe(1);expect(tools.toolNames).not.toContain("memory");await memory.close();
}));
test("忽略 Memory 后即使模型试图读索引也被真实工具链拒绝",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);const fake=createFakeLLM([assistantToolCall("read_file",{path:join(memory.directory,"views/MEMORY.md")},"read"),assistantText("本轮不使用")]);const tools=createToolRuntime();
 await createMemoryAwareAgentRunner(createAgentRunner({callLLM:fake.callLLM,compactHistory:noCompact}),memory)("忽略记忆",createInitialHistory(cwd,"glm-test"),()=>{},(()=>{const ctx=createTestContext(cwd);ctx.memoryFiles=memory.fileAccess(ctx);return ctx;})(),EMPTY_AGENT_INPUT_CHANNEL,{getToolSchemas:tools.getToolSchemas,executeTool:tools.executeTool,isToolConcurrencySafe:tools.isConcurrencySafe});
 expect(JSON.stringify(fake.calls[1]?.messages)).toContain("没有 Memory");await memory.close();
}));
