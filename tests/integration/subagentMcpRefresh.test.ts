import {expect, test} from 'bun:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {withTempProject} from '../helpers/tempProject.js';
import {testChildEnvironment} from '../helpers/childEnvironment.js';
import {createTestContext} from '../helpers/testContext.js';
import {createMcpManager} from '../../src/mcp/manager.js';
import {createSubagentFactories} from '../../src/subagents/runSubagent.js';
import {BUILTIN_SUBAGENT_REGISTRY} from '../../src/subagents/registry.js';
import {createToolResultStore} from '../../src/toolResults/store.js';
import {EMPTY_AGENT_INPUT_CHANNEL} from '../../src/agent/inputChannel.js';
import type {AgentRunner} from '../../src/agent/runner.js';
test("existing child rediscovery uses the reconnected MCP capability", async () => withTempProject(async(cwd,storage)=>{
 await mkdir(storage.hicodeHome,{recursive:true});
 await writeFile(join(storage.hicodeHome,'mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[join(import.meta.dir,'../fixtures/mcp/lifecycleServer.ts')],timeoutMs:2000}}}));
 const manager=createMcpManager({cwd,storage,childEnvironment:testChildEnvironment,headless:true});
 try{
  await manager.initialize();
  if(manager.getSnapshots()[0]?.status!=='connected')throw new Error(JSON.stringify(manager.getSnapshots()));
  const ctx=createTestContext(cwd,{mcpManager:manager});let run=0;
  const fake:AgentRunner=async(_p,_h,_e,child,_i,options)=>{
   run++;
   const search=await options.executeTool('tool_search','{"query":"select: mcp__fixture__old"}',child,`lookup-${run}`);
   options.getToolSchemas();
   const result=await options.executeTool('mcp__fixture__old','{}',child,`call-${run}`);
   expect(typeof search !== "string" && search.outcome).toBe("ok");
   expect(typeof result !== "string" && result.outcome).toBe("ok");
   return {reason:'completed',reply:'done',iterations:1};
  };
  const factory=createSubagentFactories({primaryRunAgent:fake,fastRunAgent:fake,registry:BUILTIN_SUBAGENT_REGISTRY,createToolResultStore:(cwd,id)=>createToolResultStore(storage,cwd,id)});
  const child=factory.createSubagentThread({parentContext:ctx,onEvent:()=>{},agentId:'real-mcp'},{agentType:'Worker',description:'reconnect',prompt:'read',parentToolCallId:'spawn'});
  await child.run({prompt:'read',signal:ctx.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
  await manager.reconnect('fixture');
  await child.run({prompt:'read again',signal:ctx.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
 }finally{await manager.closeAll()}
}));
