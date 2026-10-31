import {expect,test} from "bun:test";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {withTempProject} from "../helpers/tempProject.js";
import {createSandboxRuntime} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";
import {testChildEnvironment} from "../helpers/childEnvironment.js";
import {createTestContext} from "../helpers/testContext.js";
import {createDirectoryAccessRuntime} from "../../src/permissions/directoryAccess.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createFakeLLM,assistantToolCall,assistantText} from "../helpers/fakeLLM.js";
import {EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/inputChannel.js";
import {createTaskRuntimeForTest} from "../helpers/taskRuntime.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";

for (const networkMode of ["open","restricted"] as const) {
  for (const managed of [false, true]) {
    test.skipIf(process.env.HICODE_RUN_SANDBOX_INTEGRATION!=="1")(`child Bash declares write roots before execution and cannot read private records (${networkMode}, managed=${managed})`,async()=>{
        await withTempProject(async(outer,storage)=>{
            const cwd=join(outer,"a"), target=join(outer,"b");await mkdir(cwd);await mkdir(target);
            await mkdir(storage.projectsRoot,{recursive:true});
            const secret=join(storage.projectsRoot,"private-record");await writeFile(secret,"PRIVATE_RECORD_NEEDLE");
            const sandbox=await createSandboxRuntime({cwd,storage,settings:{filesystem:{denyRead:[],denyWrite:[]},network:{mode:networkMode,allowedDomains:[],allowLocalBinding:false}}});
            expect(sandbox.status.kind).toBe("ready");
            const shellRunner=createShellRunner(sandbox,testChildEnvironment);
            const runtime=createTaskRuntimeForTest(cwd,shellRunner,undefined,storage.hicodeHome);
            const store=createTestToolResultStore(cwd,"test-session",{hicodeHome:storage.hicodeHome});
            let approvals=0;
            const parent=createTestContext(cwd,{workspaceBoundary:outer,directoryAccess:createDirectoryAccessRuntime({cwd,hardBoundary:outer}),
                toolResultStore:store,
                ...(managed?{tasks:runtime.forSession({sessionId:store.sessionId,toolResultStore:store})}:{}),
                shellRunner,canUseTool:async(_tool,_message,_input,options)=>{
                    approvals++;expect(options?.presentation).toMatchObject({kind:"filesystem_access",targetPath:await import("node:fs/promises").then(fs=>fs.realpath(target))});
                    await expect(readFile(join(target,"written"))).rejects.toThrow();
                    return {behavior:"allow",directoryScope:"once"};
                }});
            parent.storage=storage;
            const fake=createFakeLLM([
                assistantToolCall("bash",{command:"printf approved > written",cwd:target,additional_write_directories:[target],...(managed?{yield_time_ms:1000}:{})},"write"),
                options=>{expect(options.messages.find(m=>m.role==="tool"&&m.tool_call_id==="write")?.content).not.toContain("denied");return assistantToolCall("read_file",{path:secret},"private");},
                options=>{expect(options.messages.find(m=>m.role==="tool"&&m.tool_call_id==="private")?.content).toContain("Private session storage");return assistantToolCall("bash",{command:`P='${secret}'; cat "$P"`,...(managed?{yield_time_ms:1000}:{})},"compound");},
                options=>{const result=String(options.messages.find(m=>m.role==="tool"&&m.tool_call_id==="compound")?.content);expect(result).not.toContain("PRIVATE_RECORD_NEEDLE");expect(result).toMatch(/permitted|denied|code 1/i);return assistantText("verified");},
            ]);
            const thread=createSubagentThreadForTest({parentContext:parent,agentId:"worker",onEvent(){},agentOptions:{callLLM:fake.callLLM},toolResultStoreOptions:{hicodeHome:storage.hicodeHome}},
                {agentType:"Worker",cwd:target,description:"scope",prompt:"test",parentToolCallId:"spawn"});
            try {
                await thread.run({prompt:"test",signal:new AbortController().signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
                expect(await readFile(join(target,"written"),"utf8")).toBe("approved");
                expect(approvals).toBe(1);expect(await parent.directoryAccess.canAccess(target)).toBe(false);
            } finally {await thread.close();await runtime.close();await sandbox.close();}
        });
    });
  }
}
