import {contentText} from "../../src/images/content.js";
import {expect,test} from "bun:test";
import {join} from "node:path";
import {createAgentRunner,EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/index.js";
import {createMemoryAwareAgentRunner} from "../../src/memory/runtime.js";
import {serializeMemoryTopic} from "../../src/memory/topic.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import {assistantText,assistantToolCall,createFakeLLM} from "../helpers/fakeLLM.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";
const noCompact=async({preTokenCount}:{preTokenCount:number})=>({compacted:false as const,preTokenCount,threshold:1_000_000});
test("Root 使用标准工具单次接收 note，下一轮直接召回，不维护索引",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);const path=join(memory.directory,"topics","brief.md");
 const fake=createFakeLLM([assistantToolCall("write_file",{path,content:serializeMemoryTopic({name:"Preference",description:"Saved preference",type:"feedback",content:"保持简洁"})},"note"),assistantText("已记住")]);
 const root=createMemoryAwareAgentRunner(createAgentRunner({callLLM:fake.callLLM,compactHistory:noCompact}),memory);const tools=createToolRuntime();const events:string[]=[];
 const result=await root("请记住保持简洁",createInitialHistory(cwd,"glm-test"),event=>{events.push(event.type);},(()=>{const ctx=createTestContext(cwd);ctx.memoryFiles=memory.fileAccess(ctx);return ctx;})(),EMPTY_AGENT_INPUT_CHANNEL,{getToolSchemas:tools.getToolSchemas,executeTool:tools.executeTool,isToolConcurrencySafe:tools.isConcurrencySafe});
 expect(fake.calls[1]?.messages.some(message=>message.role==="user"&&contentText(message.content).includes("topics/brief.md"))).toBe(true);expect(result.reason).toBe("completed");expect(events).toContain("memory_update");expect((await memory.read("brief"))?.content).toBe("保持简洁");expect((await memory.status()).pending).toBe(0);expect(tools.toolNames).not.toContain("memory");await memory.close();
}));
test("忽略 Memory 后即使模型试图读索引也被真实工具链拒绝",async()=>withTempProject(async cwd=>{
 const memory=createTestMemoryRuntime(cwd);const fake=createFakeLLM([assistantToolCall("read_file",{path:join(memory.directory,"MEMORY.md")},"read"),assistantText("本轮不使用")]);const tools=createToolRuntime();
 await createMemoryAwareAgentRunner(createAgentRunner({callLLM:fake.callLLM,compactHistory:noCompact}),memory)("忽略记忆",createInitialHistory(cwd,"glm-test"),()=>{},(()=>{const ctx=createTestContext(cwd);ctx.memoryFiles=memory.fileAccess(ctx);return ctx;})(),EMPTY_AGENT_INPUT_CHANNEL,{getToolSchemas:tools.getToolSchemas,executeTool:tools.executeTool,isToolConcurrencySafe:tools.isConcurrencySafe});
 expect(JSON.stringify(fake.calls[1]?.messages)).toContain("no Memory");await memory.close();
}));

test("Memory overlay sees a project tool grant on the very next call in the same turn", async () => withTempProject(async cwd => {
 const {z} = await import("zod");
 const {addToAllowList} = await import("../../src/permissions/addRule.js");
 const memory = createTestMemoryRuntime(cwd);
 let rules: import("../../src/permissions/types.js").PermissionRules = {allow: [], ask: [], deny: []};
 let approvals = 0, executions = 0;
 const name = "mcp__fixture__execute";
 const ctx = createTestContext(cwd, {canUseTool: async () => {
  approvals++; rules = await addToAllowList(name, rules, cwd); return {behavior: "allow"};
 }});
 Object.defineProperty(ctx, "permissionRules", {get: () => rules});
 const tools = createToolRuntime({additionalTools: [{name, description: "Fixture", parameters: z.object({}),
  isReadOnly: () => false, checkPermissions: async () => ({behavior: "ask", message: "Approve fixture"}),
  async execute() {executions++; return "done";}}]});
 const fake = createFakeLLM([assistantToolCall(name, {}, "first"), assistantToolCall(name, {}, "second"), assistantText("done")]);
 try {
  await createMemoryAwareAgentRunner(createAgentRunner({callLLM: fake.callLLM, compactHistory: noCompact}), memory)(
   "run twice", createInitialHistory(cwd, "glm-test"), () => {}, ctx, EMPTY_AGENT_INPUT_CHANNEL,
   {getToolSchemas: tools.getToolSchemas, executeTool: tools.executeTool, isToolConcurrencySafe: tools.isConcurrencySafe});
  expect(executions).toBe(2); expect(approvals).toBe(1);
  expect(JSON.parse(await Bun.file(join(cwd, ".hicode/settings.local.json")).text()).permissions.allow).toContain(name);
 } finally {await memory.close();}
}));

test("Memory overlay keeps live modes and revocations without granting Memory access", async () => withTempProject(async cwd => {
 const memory = createTestMemoryRuntime(cwd);
 const ctx = createTestContext(cwd);const original = memory.fileAccess(ctx);ctx.memoryFiles = original;
 let rules: import("../../src/permissions/types.js").PermissionRules = {allow: [], ask: [], deny: []};
 Object.defineProperty(ctx, "permissionRules", {get: () => rules});
 let promptPolicy: "onRequest" | "never" = "onRequest";
 Object.defineProperty(ctx, "permissionPromptPolicy", {get: () => promptPolicy});
 try {await createMemoryAwareAgentRunner(async (_input, _history, _event, scoped) => {
  expect(scoped.memoryFiles).toBeUndefined();expect(ctx.memoryFiles).toBe(original);
  ctx.setPermissionMode("full-access");ctx.setCollaborationMode("plan");promptPolicy="never";
  rules={...rules,deny:[{source:"local",toolName:"mcp__fixture__execute"}]};
  expect(scoped.permissionMode).toBe("full-access");expect(scoped.collaborationMode).toBe("plan");
  expect(scoped.permissionPromptPolicy).toBe("never");expect(scoped.permissionRules).toBe(rules);
  return {reply:"done",reason:"completed",iterations:1};
 },memory)("忽略记忆",[],()=>{},ctx,EMPTY_AGENT_INPUT_CHANNEL,{getToolSchemas:()=>[],executeTool:async()=>"",isToolConcurrencySafe:()=>false});}
 finally {await memory.close();}
}));
