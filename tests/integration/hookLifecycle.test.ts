import {expect, test} from "bun:test";
import {mkdir, writeFile, realpath} from "node:fs/promises";
import {join} from "node:path";
import {createAgentRunner, EMPTY_AGENT_INPUT_CHANNEL} from "../../src/agent/index.js";
import type {AgentEvent} from "../../src/agent/types.js";
import {createCompactState} from "../../src/context/index.js";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {createHookRuntimeFactory, type HookEnvelope, type HookInput, type ResolvedHookSettings} from "../../src/hooks/index.js";
import {createRootRuntimeResourcesFactory, type RootRuntimeResources} from "../../src/runtime/resources.js";
import {createRootSessionRuntime} from "../../src/runtime/sessionRuntime.js";
import {runRootTurn, createRootTurnRunnerFactory} from "../../src/runtime/turnRuntime.js";
import {createTestRootConfiguration, createTestSettings} from "../helpers/runtimeResources.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";
import {createSubagentThreadForTest} from "../helpers/subagent.js";
import {createEmptyResolvedHookSettings, resolvedHooks} from "../helpers/hooks.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {loadHiCodeSettings} from "../../src/settings/index.js";
import type {HiCodeStorageLayout} from "../../src/persistence/index.js";
import type {ToolContextHost} from "../../src/runtime/toolContext.js";
import type {Message} from "../../src/llm/types.js";
import {hooksCommand} from "../../src/slash/commands/hooks.js";
import {executeToolCallBatch} from "../../src/agent/toolBatch.js";

const sources = {settings: ["project"] as const, instructions: [], skills: [], agents: [], mcp: []};
const host: ToolContextHost = {
    canUseTool: async () => ({behavior: "allow"}), getPermissionRules: () => ({allow: [], ask: [], deny: []}),
    getPermissionMode: () => "ask", getCollaborationMode: () => "build", getPermissionPromptPolicy: () => "onRequest",
    setTodos() {},
};
function sessionFor(resources: RootRuntimeResources) {
    return createRootSessionRuntime({resources,  seed: {sessionId: "hooks-case",
        history: [{role: "system", content: "test"}], compactState: createCompactState()}});
}
async function resourcesFor(cwd: string, storage: HiCodeStorageLayout, hooks: ResolvedHookSettings,
    handler: (input: HookInput) => unknown) {
    return createRootRuntimeResourcesFactory({createHookRuntime: createHookRuntimeFactory({
        getTrust: async () => "allow", executeCommand: async ({stdin}) => ({stdout: JSON.stringify(handler((JSON.parse(stdin) as HookEnvelope).event)),
            stderr: "", termination: {kind: "exit", code: 0}}),
    })})({configuration: createTestRootConfiguration(cwd, createTestSettings({hooks}), storage, sources)});
}
const state = () => ({todos: [], permissionMode: "ask" as const, collaborationMode: "build" as const, uiEvents: []});

for (const cancelled of [false, true]) test(`异常批次完整配对并记录结束，不启动观察脚本 cancelled=${cancelled}`, async () => {
    await withTempProject(async (cwd, storage) => {
        let commands = 0;
        const resources = await resourcesFor(cwd, storage, resolvedHooks("PostToolBatch", [
            {type: "command", purpose: "observe", command: "batch"},
        ]), () => {commands++; return {};});
        const controller = new AbortController();
        const ctx = createTestContext(cwd);
        ctx.signal = controller.signal;
        const inputs: HookInput[] = [];
        ctx.runHook = async (input, signal) => {
            inputs.push(input);
            return resources.hooks.execute(input, signal ?? ctx.signal, {session: ctx.hookSession});
        };
        const toolCalls = ["first", "second"].map(id => ({id, type: "function" as const,
            function: {name: "write_file", arguments: "{}"}}));
        const history: Message[] = [{role: "assistant", content: null, tool_calls: toolCalls}];
        try {
            const run = executeToolCallBatch({toolCalls, history, ctx, turnId: ctx.turnId, onEvent() {},
                isToolConcurrencySafe: () => false, executeTool: async () => {
                    if (cancelled) controller.abort("user-cancel");
                    throw new Error("batch-fixture-failed");
                }});
            if (cancelled) expect((await run).status).toBe("interrupted");
            else await expect(run).rejects.toThrow("batch-fixture-failed");
            expect(history.filter(item => item.role === "tool").map(item => item.tool_call_id)).toEqual(["first", "second"]);
            expect(inputs).toHaveLength(1);
            expect(inputs[0]).toMatchObject({status: cancelled ? "interrupted" : "failed",
                tools: [{tool_call_id: "first", outcome: cancelled ? "interrupted" : "failed"},
                    {tool_call_id: "second", outcome: cancelled ? "interrupted" : "failed"}]});
            expect(commands).toBe(0);
        } finally {await resources.close();}
    });
});

for (const repeat of [false, true]) test(`Stop 真实收尾最多续跑一次 repeat=${repeat}`, async () => {
    await withTempProject(async (cwd, storage) => {
        const inputs: HookInput[] = [];
        let stops = 0;
        const config = {...createEmptyResolvedHookSettings(),
            Stop: resolvedHooks("Stop", [{type: "command", purpose: "control", command: "review"}]).Stop,
            TurnEnd: resolvedHooks("TurnEnd", [{type: "command", purpose: "observe", command: "notify"}]).TurnEnd};
        const resources = await resourcesFor(cwd, storage, config, input => {
            inputs.push(input);
            return input.hook_event_name === "Stop" ? (++stops === 1 || repeat
                ? {decision: "continue", reason: "include concrete result"} : {decision: "accept"}) : {};
        });
        const fake = createFakeLLM([assistantText("first candidate"), assistantText("final candidate")]);
        resources.agentRuntime.runAgent = createAgentRunner({callLLM: fake.callLLM, compactHistory: resources.agentRuntime.compactHistory});
        const session = sessionFor(resources);
        const events: AgentEvent[] = [];
        try {
            const result = await runRootTurn({resources, session, turnId: "host-turn", prompt: "finish", signal: new AbortController().signal,
                host, onEvent: event => {events.push(event);}, onHookResult() {}, onLifecycleIssue(issue) {throw issue.error;}, getSnapshotState: state});
            expect(result.reason).toBe(repeat ? "hook_limit" : "completed");
            expect(fake.calls).toHaveLength(2);
            expect(inputs.filter(item => item.hook_event_name === "Stop").map(item => item.continuation_used)).toEqual([false, true]);
            expect(events.filter(item => item.type === "assistant_text").map(item => item.content).join("\n")).not.toContain("first candidate");
            expect(inputs.at(-1)).toMatchObject({hook_event_name: "TurnEnd", turn_id: "host-turn", status: repeat ? "limit" : "completed", persistence_status: "saved"});
            expect(events.filter(item => item.type === "turn_end")).toHaveLength(1);
        } finally {await resources.close();}
    });
});

test("批次回执在工具配对后交付一次；UI 消息不进入模型上下文", async () => {
    await withTempProject(async (cwd, storage) => {
        const inputs: HookInput[] = [];
        const resources = await resourcesFor(cwd, storage, resolvedHooks("PostToolBatch", [
            {type: "command", purpose: "observe", command: "batch"},
        ]), input => {inputs.push(input); return {additionalContext: "batch-note", userMessage: "ui-only-note"};});
        const fake = createFakeLLM([assistantToolCall("write_file", {path: "result.txt", content: "done"}, "write"),
            ({messages}) => {
                expect(messages.some(item => item.role === "tool" && item.tool_call_id === "write")).toBe(true);
                expect(JSON.stringify(messages)).toContain("batch-note");
                expect(JSON.stringify(messages)).not.toContain("ui-only-note");
                return assistantText("done");
            }]);
        resources.agentRuntime.runAgent = createAgentRunner({callLLM: fake.callLLM, compactHistory: resources.agentRuntime.compactHistory});
        try {
            await runRootTurn({resources, session: sessionFor(resources), prompt: "write", signal: new AbortController().signal,
                host, onEvent() {}, onHookResult() {}, onLifecycleIssue(issue) {throw issue.error;}, getSnapshotState: state});
            expect(inputs).toHaveLength(1);
            expect(inputs[0]).toMatchObject({hook_event_name: "PostToolBatch", tools: [{tool_call_id: "write", outcome: "ok", changes: [{kind: "create"}]}]});
        } finally {await resources.close();}
    });
});

test("控制故障闭合 tool result 并停止模型；取消仅报告 TurnEnd 事实", async () => {
    await withTempProject(async (cwd, storage) => {
        const inputs: HookInput[] = [];
        const config = {...createEmptyResolvedHookSettings(),
            PreToolUse: resolvedHooks("PreToolUse", [{type: "command", purpose: "control", command: "bad"}]).PreToolUse,
            TurnEnd: resolvedHooks("TurnEnd", [{type: "command", purpose: "observe", command: "notify"}]).TurnEnd};
        const resources = await resourcesFor(cwd, storage, config, input => {inputs.push(input); return input.hook_event_name === "PreToolUse" ? {decision: "allow"} : {};});
        const fake = createFakeLLM([assistantToolCall("write_file", {path: "must-not-exist", content: "bad"}, "write")]);
        resources.agentRuntime.runAgent = createAgentRunner({callLLM: fake.callLLM, compactHistory: resources.agentRuntime.compactHistory});
        const session = sessionFor(resources);
        const run = (signal: AbortSignal, events: AgentEvent[]) => runRootTurn({resources, session, prompt: "write", signal,
            host, onEvent: event => {events.push(event);}, onHookResult() {}, onLifecycleIssue() {}, getSnapshotState: state});
        try {
            expect((await run(new AbortController().signal, [])).reason).toBe("hook_error");
            expect(fake.calls).toHaveLength(1);
            expect(session.history.filter(item => item.role === "tool" && item.tool_call_id === "write")).toHaveLength(1);
            expect(await Bun.file(join(cwd, "must-not-exist")).exists()).toBe(false);
            const count = inputs.length;
            const controller = new AbortController(); controller.abort("user-cancel");
            const events: AgentEvent[] = [];
            expect((await run(controller.signal, events)).reason).toBe("interrupted");
            expect(inputs).toHaveLength(count);
            expect(events.filter(item => item.type === "turn_end")[0]).toMatchObject({input: {status: "cancelled"}});
        } finally {await resources.close();}
    });
});

test("保存失败仍报告 TurnEnd，通知失败不覆盖原保存错误", async () => {
    await withTempProject(async (cwd, storage) => {
        const inputs: HookInput[] = [];
        const resources = await resourcesFor(cwd, storage, resolvedHooks("TurnEnd", [{type: "command", purpose: "observe", command: "notify"}]),
            input => {inputs.push(input); return {decision: "block"};});
        const fake = createFakeLLM([assistantText("done")]);
        resources.agentRuntime.runAgent = createAgentRunner({callLLM: fake.callLLM, compactHistory: resources.agentRuntime.compactHistory});
        try {
            const runner = createRootTurnRunnerFactory({saveSession: async () => {throw new Error("disk-failed");}});
            await expect(runner({resources, session: sessionFor(resources), prompt: "finish", signal: new AbortController().signal,
                host, onEvent() {}, onHookResult() {}, onLifecycleIssue() {}, getSnapshotState: state})).rejects.toThrow("disk-failed");
            expect(inputs).toHaveLength(1);
            expect(inputs[0]).toMatchObject({hook_event_name: "TurnEnd", persistence_status: "failed"});
        } finally {await resources.close();}
    });
});

for (const trigger of ["auto", "manual"] as const) test(`实际 ${trigger} 压缩前后各一次，失败保留 History`, async () => {
    await withTempProject(async (cwd) => {
        const ctx = createTestContext(cwd);
        const inputs: HookInput[] = [];
        ctx.runHook = async input => {inputs.push(input); return {blocked: false, executions: [], additionalContexts: [input.hook_event_name === "PreCompact" ? "keep-api" : "handoff-note"]};};
        const original: Message[] = [{role: "system", content: "system"}, {role: "user", origin: "user" as const, content: "old".repeat(20000)},
            {role: "assistant", content: "old answer"}, {role: "user", origin: "user" as const, content: "new task"}];
        let fail = false;
        const compact = createCompactHistoryRunner({generateSummary: async input => {
            expect(input.customInstructions).toContain("keep-api");
            if (fail) throw new Error("summary failed");
            return "summary";
        }});
        const history = structuredClone(original);
        const result = await compact({history, ctx, tools: [], preTokenCount: 20000, force: true, trigger});
        expect(result.compacted).toBe(true);
        expect(inputs.map(item => item.hook_event_name)).toEqual(["PreCompact", "PostCompact"]);
        expect(history[1]?.content).toContain("handoff-note");
        fail = true; inputs.length = 0;
        const failed = structuredClone(original);
        expect((await compact({history: failed, ctx, tools: [], preTokenCount: 20000, force: true, trigger})).compacted).toBe(false);
        expect(failed).toEqual(original);
        expect(inputs.at(-1)).toMatchObject({hook_event_name: "PostCompact", status: "failed"});
        inputs.length = 0;
        await compact({history: original.slice(0, 2), ctx, tools: [], preTokenCount: 20000, force: true, trigger});
        expect(inputs).toHaveLength(0);
    });
});

test("PostCompact 超预算上下文不会抵消压缩或再次触发摘要", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const oversized = "界".repeat(10000);
        const events: string[] = [];
        ctx.runHook = async input => {
            events.push(input.hook_event_name);
            return {blocked: false, executions: [], additionalContexts: input.hook_event_name === "PostCompact" ? [oversized] : []};
        };
        let summaries = 0;
        const compact = createCompactHistoryRunner({generateSummary: async () => {summaries++; return "summary";}});
        const history: Message[] = [{role: "system", content: "test"}, {role: "user", origin: "user" as const, content: "old".repeat(20000)},
            {role: "assistant", content: "old answer"}, {role: "user", origin: "user" as const, content: "latest task"}];
        const result = await compact({history, ctx, tools: [], preTokenCount: 20000, contextWindow: 4096, force: true});
        expect(result.compacted).toBe(true);
        expect(result.postTokenCount).toBeLessThan(result.threshold);
        expect(JSON.stringify(history)).not.toContain(oversized);
        expect(summaries).toBe(1);
        expect(events).toEqual(["PreCompact", "PostCompact"]);
    });
});

test("子 Agent 两次真实运行携带 runCount/taskId，父 Hook 能力不进入 child", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const inputs: HookInput[] = [];
        ctx.runHook = async input => {inputs.push(input); return {blocked: false, executions: [], additionalContexts: []};};
        const fake = createFakeLLM([assistantText("first"), assistantText("second")]);
        const thread = createSubagentThreadForTest({agentId: "child-id", parentContext: ctx, onEvent() {}, agentOptions: {callLLM: fake.callLLM}}, {
             agentType: "Explore", description: "read", prompt: "read", parentToolCallId: "parent",
        });
        expect(inputs).toHaveLength(0);
        const signal = new AbortController().signal;
        for (let i = 0; i < 2; i++) await thread.run({prompt: "read", signal, inputChannel: EMPTY_AGENT_INPUT_CHANNEL, taskId: "task-id"});
        expect(inputs.map(item => item.hook_event_name)).toEqual(["SubagentStart", "SubagentStop", "SubagentStart", "SubagentStop"]);
        expect(inputs.map(item => "run_count" in item ? item.run_count : 0)).toEqual([1, 1, 2, 2]);
        expect(inputs.every(item => "task_id" in item && item.task_id === "task-id")).toBe(true);
        // A child's Stop/UserPromptSubmit/PreCompact must not appear in the parent hook stream.
        expect(fake.calls).toHaveLength(2);
    });
});

test("Root /hooks reload 仅重读声明来源，活动 Turn 禁止重载，坏配置保留批准", async () => {
    await withTempProject(async (cwd, storage) => {
        const path = join(cwd, ".hicode", "settings.json");
        await mkdir(join(cwd, ".hicode"));
        const declaration = {hooks: {SessionStart: [{hooks: [{type: "command", purpose: "observe", command: "true"}]}]}};
        await writeFile(path, JSON.stringify(declaration));
        const loaded = loadHiCodeSettings({cwd, storage, sources: ["project"]});
        let approvals = 0;
        const resources = await createRootRuntimeResourcesFactory()({
            configuration: createTestRootConfiguration(cwd, createTestSettings({hooks: loaded.values.hooks}), storage, sources),
            requestHookTrust: async () => {approvals++; return "once";},
        });
        try {
            const session = sessionFor(resources);
            const ctx = session.createContext({getSnapshotState: () => ({todos: [], uiEvents: [], permissionMode: "ask", collaborationMode: "build"}),host, signal: new AbortController().signal, onEvent() {}});
            const release = resources.holdHookConfiguration();
            await expect(ctx.hookControl!.reload(ctx.signal)).rejects.toThrow("still active");
            release();
            await ctx.hookControl!.reload(ctx.signal);
            expect(approvals).toBe(1);
            const before = resources.hooks.inspect();
            await writeFile(path, '{"hooks":{"Typo":[]}}');
            await expect(ctx.hookControl!.reload(ctx.signal)).rejects.toThrow();
            expect(resources.hooks.inspect()).toEqual(before);
            const output: AgentEvent[] = [];
            await hooksCommand.execute("", {ctx, history: [], onEvent: event => {output.push(event);},
                compactHistory: resources.agentRuntime.compactHistory, getToolSchemas: resources.toolRuntime.getToolSchemas,
                subagents: resources.subagents});
            expect(JSON.stringify(output)).toContain("approved");
            expect(JSON.stringify(output)).toContain("SessionStart");
        } finally {await resources.close();}
    });
});

test("delegated tools enforce approved policies and keep independent once state across follow-up", async () => withTempProject(async (cwd, storage) => {
    const envelopes: HookEnvelope[] = [];
    const hooks = {...resolvedHooks("PreToolUse", [{type:"command",purpose:"control",command:"policy"}]),
        PostToolUse: resolvedHooks("PostToolUse", [{type:"command",purpose:"observe",command:"audit",once:true}]).PostToolUse};
    const resources = await createRootRuntimeResourcesFactory({createHookRuntime:createHookRuntimeFactory({
        getTrust:async()=>"allow",executeCommand:async({stdin})=>{
            const envelope:HookEnvelope=JSON.parse(stdin);envelopes.push(envelope);
            const event=envelope.event;
            const blocked=event.hook_event_name==="PreToolUse"&&String(event.tool_input.path).includes("blocked");
            return {stdout:JSON.stringify(blocked?{decision:"block",reason:"project policy"}:event.hook_event_name==="PreToolUse"?{decision:"pass"}:{}),stderr:"",termination:{kind:"exit",code:0}};
        },
    })})({configuration:createTestRootConfiguration(cwd,createTestSettings({hooks}),storage,sources)});
    const session=sessionFor(resources);
    const childCwd=join(cwd,"child");await mkdir(childCwd);await writeFile(join(childCwd,"allowed.txt"),"allowed");
    try {
        await session.initialize();
        const ctx=session.createContext({signal:new AbortController().signal,host,onEvent:()=>{},getSnapshotState:state});
        expect(ctx.toolHooks).toBeDefined();
        expect("reload" in ctx.toolHooks!).toBe(false);
        const workerModel=createFakeLLM([
            assistantToolCall("read_file",{path:"allowed.txt"},"read-1"),assistantText("read"),
            assistantToolCall("read_file",{path:"allowed.txt"},"read-2"),assistantText("read again"),
            assistantToolCall("write_file",{path:"blocked.txt",content:"must not be written"},"blocked-write"),
            options=>{expect(JSON.stringify(options.messages)).toContain("project policy");return assistantText("blocked as required");},
        ]);
        const worker=createSubagentThreadForTest({parentContext:ctx,onEvent:()=>{},agentId:"policy-worker",agentOptions:{callLLM:workerModel.callLLM}},
            {agentType:"Worker",cwd:childCwd,workspaceWriteApproved:true,description:"worker",prompt:"read",parentToolCallId:"spawn"});
        for(const prompt of ["read","read again","try blocked write"])await worker.run({prompt,signal:ctx.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
        const explorerModel=createFakeLLM([assistantToolCall("read_file",{path:"allowed.txt"},"explore-read"),assistantText("done")]);
        const explorer=createSubagentThreadForTest({parentContext:ctx,onEvent:()=>{},agentId:"policy-explore",agentOptions:{callLLM:explorerModel.callLLM}},
            {agentType:"Explore",cwd:childCwd,description:"explore",prompt:"read",parentToolCallId:"spawn-explore"});
        await explorer.run({prompt:"read",signal:ctx.signal,inputChannel:EMPTY_AGENT_INPUT_CHANNEL});
        expect(await Bun.file(join(childCwd,"blocked.txt")).exists()).toBe(false);
        expect((await resources.toolRuntime.executeTool("read_file",JSON.stringify({path:join(childCwd,"allowed.txt")}),ctx,"root-read")).outcome).toBe("ok");
        const audits=envelopes.filter(item=>item.event.hook_event_name==="PostToolUse");
        expect(audits.map(item=>item.actor?.agent_id??"root")).toEqual(["policy-worker","policy-explore","root"]);
        expect(audits[0]?.actor).toMatchObject({kind:"subagent",cwd:await realpath(childCwd),parent_session_id:session.sessionId});
        expect(audits[0]?.cwd).toBe(resources.cwd);
        await expect(Promise.resolve().then(() => ctx.toolHooks!.execute({hook_event_name:"SessionEnd",session_id:session.sessionId,reason:"invalid"},ctx.signal))).rejects.toThrow("tool events only");
    }finally{await resources.close();}
}));
