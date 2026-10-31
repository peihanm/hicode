import {afterEach,expect,test} from "bun:test";
import {render,cleanup} from "ink-testing-library";
import {mkdir,readFile} from "node:fs/promises";
import {join} from "node:path";
import {AppForTest} from "../helpers/AppForTest.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createFakeLLM,assistantToolCall,assistantText} from "../helpers/fakeLLM.js";
import type {AgentRunner} from "../../src/agent/index.js";

afterEach(cleanup);
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await tick();expect(check()).toBe(true);}

test.each(["allow", "deny"])("background permission after Root turn ends: %s",async decision=>{
    await withTempProject(async(outer,storage)=>{
        const cwd=join(outer,"a"),target=join(outer,"b");await mkdir(cwd);await mkdir(target);
        let release!:()=>void;
        const gate=new Promise<void>(resolve=>{release=resolve;});
        let finished=false;
        const fake=createFakeLLM([async()=>{await gate;return assistantToolCall("write_file",{path:"output",content:"APPROVED"},"write");},()=>{finished=true;return assistantText("done");}]);
        const base=createTestRuntimeResources(cwd,{storage,agentRuntime:{
            runAgent:async()=>{throw new Error("replaced");},compactHistory:async()=>{throw new Error("unused");},
            reviewApproval:async()=>{throw new Error("unused");},reviewTask:async()=>{throw new Error("unused");},
            createSubagentThread:(options,request)=>createSubagentThreadForTest({...options,toolResultStoreOptions:{hicodeHome:storage.hicodeHome},agentOptions:{callLLM:fake.callLLM}},request),
        }});
        // A bounded fixture runner deliberately returns while its child waits, exercising Session rather than Turn ownership.
        const runner:AgentRunner=async(_input,_history,emit,ctx)=>{
            await ctx.subagentLauncher!.launch({agentType:"Worker",name:"background-writer",description:"write in B",prompt:"write",cwd:target,parentToolCallId:"spawn",context:"fresh"});
            await emit({type:"assistant_text",phase:"final",content:"ROOT_TURN_FINISHED"});
            return {reply:"ROOT_TURN_FINISHED",reason:"completed",iterations:1};
        };
        const view=render(<AppForTest resources={{...base,workspaceBoundary:outer}} runAgentImpl={runner}/>);
        try {
            await tick();view.stdin.write("start");await tick();view.stdin.write("\r");
            await until(()=>view.lastFrame()?.includes("ROOT_TURN_FINISHED")??false);
            release();await until(()=>view.lastFrame()?.includes("FILE ACCESS")??false);
            expect(view.lastFrame()).toContain("background-writer");
            expect(view.lastFrame()).toContain("Allow this directory for this session");
            await expect(readFile(join(target,"output"))).rejects.toThrow();
            view.stdin.write(decision === "allow" ? "\r" : "\x1b");await until(()=>finished);
            if (decision === "allow") expect(await readFile(join(target,"output"),"utf8")).toBe("APPROVED");
            else await expect(readFile(join(target,"output"))).rejects.toThrow();
        }finally{release();view.unmount();await base.close();}
    });
});
