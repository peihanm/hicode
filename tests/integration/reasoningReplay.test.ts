import {afterEach, expect, test} from "bun:test";
import {createLLMCaller} from "../../src/llm/index.js";
import type {LLMSourceConnection, Message, OpenAITool} from "../../src/llm/types.js";
import {createSessionPersistence, loadSession} from "../../src/session/storage.js";
import {decodeSessionContentBlock} from "../../src/session/codec.js";
import {estimateMessageTokens} from "../../src/context/tokens.js";
import {withTempProject} from "../helpers/tempProject.js";
import {compactHistoryForTest} from "../helpers/compact.js";
import {createTestContext} from "../helpers/testContext.js";
import {assistantText, createFakeLLM} from "../helpers/fakeLLM.js";

const source: LLMSourceConnection = {id:"qwen", label:"Qwen", apiKeyEnv:"HICODE_REPLAY_TEST_KEY", baseUrl:"https://qwen.test/v1"};
const tools: OpenAITool[] = [{type:"function", function:{name:"read_file", description:"Read", parameters:{type:"object"}}}];
const originalFetch = globalThis.fetch;
const originalKey = process.env.HICODE_REPLAY_TEST_KEY;
afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.HICODE_REPLAY_TEST_KEY;
    else process.env.HICODE_REPLAY_TEST_KEY = originalKey;
});

function response(reasoning: string, tool: boolean) {
    const chunks = [
        {choices:[{delta:{reasoning_content:reasoning.slice(0, 7)}}]},
        {choices:[{delta:{reasoning_content:reasoning.slice(7)}}]},
        {choices:[{delta:tool
            ? {tool_calls:[{index:0, id:"read-1", type:"function", function:{name:"read_file", arguments:'{"path":"a.ts"}'}}]}
            : {content:"Complete"}, finish_reason:tool ? "tool_calls" : "stop"}]},
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
        {headers:{"content-type":"text/event-stream"}});
}

test.each(["qwen", "deepseek", "qwen-token-plan"] as const)("%s replays tool and text reasoning across Session restore and a follow-up", async id => {
    await withTempProject(async (cwd, storage) => {
        process.env.HICODE_REPLAY_TEST_KEY = "fixture-key";
        const call = createLLMCaller({...source, id});
        const model = id === "qwen" ? "qwen3.8-flash" : id === "qwen-token-plan" ? "deepseek-v4.1-flash" : "deepseek-flash";
        const longReasoning = "Compare candidate moves α\n".repeat(3000);
        let calls = 0;
        globalThis.fetch = (async (_input, init) => {
            const request = JSON.parse(String(init?.body));
            expect(request).not.toHaveProperty("reasoning_effort");
            expect(request).not.toHaveProperty("thinking_budget");
            if (id === "qwen") expect(request.preserve_thinking).toBe(true);
            if (id === "qwen-token-plan") {
                expect(request.enable_thinking).toBe(true);
                expect(request).not.toHaveProperty("thinking");
                expect(request).not.toHaveProperty("preserve_thinking");
            }
            const assistants = request.messages.filter((message: {role:string}) => message.role === "assistant");
            if (calls > 0) {
                expect(assistants[0].reasoning_content).toBe(longReasoning);
                expect(assistants[0]).not.toHaveProperty("reasoning");
                expect(request.messages.some((message: {role:string;tool_call_id?:string}) => message.role === "tool" && message.tool_call_id === "read-1")).toBe(true);
            }
            if (calls === 2) expect(assistants[1].reasoning_content).toBe("Reasoning before the final answer");
            return response(calls++ === 0 ? longReasoning : "Reasoning before the final answer", calls === 1);
        }) as typeof fetch;
        const history: Message[] = [{role:"user", origin:"user", content:"Inspect the file"}];
        const first = await call(history, tools, storage, cwd, model, "main");
        if (first.message.role !== "assistant") throw new Error("Expected an assistant reply");
        expect(first.message.reasoning?.content).toBe(longReasoning);
        expect(first.message.reasoning?.scope).toMatch(/^[a-f0-9]{64}$/);
        expect(estimateMessageTokens(first.message)).toBeGreaterThan(10_000);
        history.push(first.message, {role:"tool", tool_call_id:"read-1", content:"file contents"});
        const writer = createSessionPersistence(storage, cwd, "replay");
        await writer.save({cwd, sessionId:"replay", model, history, todos:[], permissionMode:"ask", collaborationMode:"build"});
        const restored = loadSession(storage, cwd, "replay", model);
        expect(restored).not.toBeNull();
        const next = restored!.history;
        const second = await call(next, tools, storage, cwd, model, "main");
        expect(second.message).toMatchObject({reasoning:{content:"Reasoning before the final answer"}});
        next.push(second.message, {role:"user", origin:"user", content:"Now explain the result"});
        await call(next, tools, storage, cwd, model, "main");
        expect(calls).toBe(3);
    });
});

test.each([
    {id:"qwen" as const, model:"qwen3.8-flash"},
    {id:"qwen-token-plan" as const, model:"deepseek-v4.1-flash"},
])("$id reasoning replay is scoped to source, endpoint and model without mutating History", async ({id, model}) => {
    await withTempProject(async (cwd, storage) => {
        process.env.HICODE_REPLAY_TEST_KEY = "fixture-key";
        const selected = {...source, id};
        globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => response("original model reasoning", false)) as typeof fetch;
        const user: Message = {role:"user", origin:"user", content:"hello"};
        const first = await createLLMCaller(selected)([user], tools, storage, cwd, model, "main");
        const history: Message[] = [user, first.message, {role:"user", origin:"user", content:"continue"}];
        for (const target of [
            {source:selected, model:"qwen3.8-max"},
            {source:{...selected, baseUrl:"https://other.test/v1"}, model},
            {source:{...selected, id:"deepseek" as const}, model},
            {source:{...selected, id:id === "qwen-token-plan" ? "qwen" as const : "qwen-token-plan" as const}, model},
            {source:selected, model:"qwen3-coder-plus"},
            {source:selected, model:"deepseek-v4.1-flash-unconfirmed-alias"},
            {source:selected, model:"vendor/custom-alias"},
        ]) {
            globalThis.fetch = (async (_input, init) => {
                const request = JSON.parse(String(init?.body));
                expect(request.messages[1]).toEqual({role:"assistant", content:"Complete"});
                return response("another result", false);
            }) as typeof fetch;
            await createLLMCaller(target.source)(history, tools, storage, cwd, target.model, "main");
        }
        globalThis.fetch = (async (_input, init) => {
            const request = JSON.parse(String(init?.body));
            expect(request.messages[1].reasoning_content).toBe("original model reasoning");
            return response("continued", false);
        }) as typeof fetch;
        await createLLMCaller(selected)(history, tools, storage, cwd, model, "main");
        expect(first.message).toMatchObject({reasoning:{content:"original model reasoning"}});
    });
});

test("Token Plan DeepSeek off and task review omit replay without discarding the original reasoning", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.HICODE_REPLAY_TEST_KEY = "fixture-key";
        const caller = createLLMCaller({...source, id:"qwen-token-plan"});
        const requests: Record<string, unknown>[] = [];
        globalThis.fetch = (async (_input, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return response("keep the verified tool result", requests.length === 1);
        }) as typeof fetch;
        const history: Message[] = [{role:"user", origin:"user", content:"Inspect the file"}];
        const first = await caller(history, tools, storage, cwd, "deepseek-v4.1-flash", "main",
            undefined, undefined, undefined, undefined, undefined, "max");
        history.push(first.message, {role:"tool", tool_call_id:"read-1", content:"verified contents"});
        const original = structuredClone(history);
        for (const kind of ["main", "task_review"] as const) {
            const reply = await caller(history, tools, storage, cwd, "deepseek-v4.1-flash", kind,
                undefined, undefined, undefined, undefined, undefined, kind === "main" ? "off" : "max");
            expect(reply.message).not.toHaveProperty("reasoning");
            const request = requests.at(-1)!;
            expect(request.enable_thinking).toBe(false);
            expect(request).not.toHaveProperty("preserve_thinking");
            expect(request.messages).toEqual([
                {role:"user", content:"Inspect the file"},
                {role:"assistant", content:null, tool_calls:first.toolCalls},
                {role:"tool", tool_call_id:"read-1", content:"verified contents"},
            ]);
        }
        await caller(history, tools, storage, cwd, "deepseek-v4.1-flash", "main",
            undefined, undefined, undefined, undefined, undefined, "max");
        expect(requests.at(-1)).toMatchObject({enable_thinking:true, reasoning_effort:"max",
            messages:[{role:"user"}, {reasoning_content:"keep the verified tool result"}, {role:"tool"}]});
        expect(history).toEqual(original);
    });
});

test("compaction keeps replay state on retained messages without exposing it in the summary request", async () => {
    await withTempProject(async cwd => {
        const reasoning = {content:"private active reasoning", scope:"a".repeat(64)};
        const history: Message[] = [
            {role:"system", content:"system"},
            {role:"user", origin:"user", content:"old context ".repeat(2500)},
            {role:"assistant", content:"old answer"},
            {role:"user", origin:"user", content:"current task"},
            {role:"assistant", content:null, reasoning, tool_calls:[{id:"read-1", type:"function", function:{name:"read_file", arguments:"{}"}}]},
            {role:"tool", tool_call_id:"read-1", content:"current result"},
        ];
        const fake = createFakeLLM([assistantText("<summary>Keep working on the current task</summary>")]);
        const result = await compactHistoryForTest({history, ctx:createTestContext(cwd), tools:[], preTokenCount:100_000, force:true, callLLM:fake.callLLM});
        expect(result.compacted).toBe(true);
        expect(history.find(message => message.role === "assistant" && message.reasoning)).toMatchObject({reasoning});
        expect(JSON.stringify(fake.calls[0]?.messages)).not.toContain(reasoning.content);
        expect(() => decodeSessionContentBlock({kind:"message", value:{role:"assistant", content:"x", reasoning:{content:"x", scope:"invalid"}}})).toThrow();
    });
});
