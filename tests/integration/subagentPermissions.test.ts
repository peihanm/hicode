import {expect, test} from "bun:test";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestRuntimeResources} from "../helpers/runtimeResources.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {createCompactState} from "../../src/context/state.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {waitForTaskCompletion} from "../../src/tasks/wait.js";
import {createDirectoryAccessRuntime} from "../../src/permissions/directoryAccess.js";
import {createTestContext} from "../helpers/testContext.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import {PermissionRequests, type PermissionRequest} from "../../src/permissions/requests.js";
import {captureApprovalEvidence} from "../../src/permissions/reviewer/evidence.js";
import type {Message} from "../../src/llm/types.js";

function pending(queue: PermissionRequests): Promise<PermissionRequest> {
    if (queue.getSnapshot()) return Promise.resolve(queue.getSnapshot()!);
    return new Promise(resolve => {
        const off = queue.subscribe(() => {const request = queue.getSnapshot(); if (request) {off(); resolve(request);}});
    });
}

test("cross-directory Worker waits in the same Task, Session approval is shared, followup needs no new approval", async () => {
    await withTempProject(async (outer, storage) => {
        const cwd=join(outer,"a"), target=join(outer,"b"); await mkdir(cwd); await mkdir(target);
        await writeFile(join(target,"source.txt"),"SOURCE");
        const fake=createFakeLLM([
            assistantToolCall("read_file",{path:"source.txt"},"read"),
            assistantToolCall("write_file",{path:"first.txt",content:"FIRST"},"write"),
            assistantText("first done"),
            assistantToolCall("write_file",{path:"second.txt",content:"SECOND"},"write-again"),
            assistantText("followup done"),
        ]);
        const resources=createTestRuntimeResources(cwd,{storage,agentRuntime:{
            runAgent:async()=>{throw new Error("No Root model");},compactHistory:async()=>{throw new Error("No compaction");},
            reviewApproval:async()=>{throw new Error("No reviewer");},reviewTask:async()=>{throw new Error("No review");},
            createSubagentThread:(options,request)=>createSubagentThreadForTest({...options,toolResultStoreOptions:{hicodeHome:storage.hicodeHome},agentOptions:{callLLM:fake.callLLM}},request),
        }});
        const session=createRootSessionRuntime({resources:{...resources,workspaceBoundary:outer},seed:{sessionId:"parent",history:[{role:"user",origin:"user",content:"Edit B"}],compactState:createCompactState()}});
        const queue=session.permissionRequests;
        const rootController=new AbortController();
        const ctx=session.createContext({signal:rootController.signal,onEvent(){},getSnapshotState:()=>({todos:[],uiEvents:[],permissionMode:"ask"}),host:{
            canUseTool:(...args)=>queue.request(...args),getPermissionRules:session.permissions.getRules,getPermissionMode:session.permissions.getMode,
            getPermissionPromptPolicy:()=>"onRequest",setTodos(){},
        }});
        try {
            await session.initialize();
            const task=await session.taskSession.startAgent({parentContext:ctx,request:{agentType:"Worker",name:"writer",description:"edit B",prompt:"read and write",cwd:target,parentToolCallId:"spawn"}});
            const request=await pending(queue);
            expect(request.actor).toEqual({agentId:task.id,name:"writer"});
            expect(fake.calls).toHaveLength(2);
            expect(await ctx.directoryAccess.canAccess(target)).toBe(false);
            expect((await session.taskSession.get(task.id))?.status).toBe("running");
            expect(queue.denyPending("Root turn ended","root")).toBe(false);
            rootController.abort("Root cancelled while child awaits permission");
            await expect(readFile(join(target,"first.txt"),"utf8")).rejects.toThrow();
            request.resolve({behavior:"allow",directoryScope:"session"});queue.clear(request);
            await waitForTaskCompletion(session.taskSession,[task.id],new AbortController().signal,"agent");
            expect(await readFile(join(target,"first.txt"),"utf8")).toBe("FIRST");
            expect(await ctx.directoryAccess.canAccess(target)).toBe(true);
            await session.taskSession.followup(task.id,"write the second file");
            await waitForTaskCompletion(session.taskSession,[task.id],new AbortController().signal,"agent");
            expect(await readFile(join(target,"second.txt"),"utf8")).toBe("SECOND");
            expect(queue.getSnapshot()).toBeNull();
            const rootWrite=await resources.toolRuntime.executeTool("write_file",JSON.stringify({path:join(target,"root.txt"),content:"ROOT"}),{...ctx,signal:new AbortController().signal},"root-write");
            expect(rootWrite.outcome).toBe("ok");
        } finally {queue.dispose();await resources.close();}
    });
});

test.each(["cancel", "mode"] as const)("once approval permits only the blocked write; %s invalidates a late allow", async cause => {
    await withTempProject(async outer => {
        const cwd=join(outer,"a"),target=join(outer,"b");await mkdir(cwd);await mkdir(target);
        const queue=new PermissionRequests(), controller=new AbortController();
        const parent=createTestContext(cwd,{workspaceBoundary:outer,directoryAccess:createDirectoryAccessRuntime({cwd,hardBoundary:outer}),canUseTool:(...args)=>queue.request(...args)});
        const fake=createFakeLLM([assistantToolCall("write_file",{path:"one",content:"ONE"},"one"),assistantToolCall("write_file",{path:"two",content:"TWO"},"two"),assistantText("permission was interrupted")]);
        const thread=createSubagentThreadForTest({parentContext:parent,agentId:"writer",onEvent(){},agentOptions:{callLLM:fake.callLLM}},
            {agentType:"Worker",description:"write",prompt:"write",cwd:target,parentToolCallId:"spawn"});
        const run=thread.run({prompt:"write",signal:controller.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
        try {
            const first=await pending(queue);first.resolve({behavior:"allow",directoryScope:"once"});queue.clear(first);
            const second=await pending(queue);expect(second.id).not.toBe(first.id);
            expect(await readFile(join(target,"one"),"utf8")).toBe("ONE");
            expect(await parent.directoryAccess.canAccess(target)).toBe(false);
            if (cause === "cancel") controller.abort("cancelled");
            else parent.setPermissionMode("full-access");
            await run;
            second.resolve({behavior:"allow",directoryScope:"session"});
            expect(queue.getSnapshot()).toBeNull();
            await expect(readFile(join(target,"two"))).rejects.toThrow();
            expect(await parent.directoryAccess.canAccess(target)).toBe(false);
        } finally {queue.dispose();await thread.close();}
    });
});

test.each(["ask","auto-review","full-access"] as const)("child uses live parent policy and independent read-only restrictions: %s", async mode => {
    await withTempProject(async cwd => {
        await writeFile(join(cwd,"source"),"SOURCE");
        let prompts=0,reviews=0;
        const history:Message[]=[{role:"user",origin:"user",content:"USER_AUTHORIZATION"}];
        const parent=createTestContext(cwd,{permissionMode:mode,canUseTool:async()=>{prompts++;return {behavior:"allow"};}});
        parent.permissionRules.ask.push({toolName:"read_file",source:"user"});
        parent.approvalEvidence=()=>captureApprovalEvidence(history);
        parent.approvalReviewer=async request=>{reviews++;expect(request.evidence.text).toContain("USER_AUTHORIZATION");expect(request.actor?.agentId).toBe("explorer");return {decision:"allow",risk:"low",reason:"authorized"};};
        const fake=createFakeLLM([assistantToolCall("read_file",{path:"source"},"read"),options=>{
            expect(options.messages.find(m=>m.role==="tool"&&m.tool_call_id==="read")?.content).toContain("SOURCE");
            return assistantText("done");}]);
        const thread=createSubagentThreadForTest({parentContext:parent,agentId:"explorer",onEvent(){},agentOptions:{callLLM:fake.callLLM}},
            {agentType:"Explore",description:"read",prompt:"read",parentToolCallId:"spawn"});
        try {await thread.run({prompt:"read",signal:new AbortController().signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
            expect(prompts).toBe(mode==="ask"?1:0);expect(reviews).toBe(mode==="auto-review"?1:0);
        } finally {await thread.close();}
    });
});

test("Session grant resolves another queued directory request while explicit ask remains pending", async () => {
    await withTempProject(async (cwd, storage) => {
        const resources=createTestRuntimeResources(cwd,{storage});
        const session=createRootSessionRuntime({resources,seed:{sessionId:"queue",history:[],compactState:createCompactState()}});
        const queue=session.permissionRequests;
        try {
            await session.initialize();
            const a=queue.request("write_file","directory",{}, {actor:{agentId:"one",name:"one"},revalidate:()=>session.directoryAccess.canAccess(cwd)});
            const b=queue.request("read_file","explicit ask",{}, {actor:{agentId:"two",name:"two"}});
            await session.directoryAccess.grantDirectory(cwd,"session");
            expect(await a).toEqual({behavior:"allow"});
            expect(queue.getSnapshot()?.question).toBe("explicit ask");
            queue.dispose();expect((await b).behavior).toBe("deny");
        } finally {await resources.close();}
    });
});
