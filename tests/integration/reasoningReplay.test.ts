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

test.each(["qwen", "deepseek"] as const)("%s replays tool and text reasoning across Session restore and a follow-up", async id => {
    await withTempProject(async (cwd, storage) => {
        process.env.HICODE_REPLAY_TEST_KEY = "fixture-key";
        const call = createLLMCaller({...source, id});
        const model = id === "qwen" ? "qwen3.8-flash" : "deepseek-flash";
        const longReasoning = "Compare candidate moves α\n".repeat(3000);
        let calls = 0;
        globalThis.fetch = (async (_input, init) => {
            const request = JSON.parse(String(init?.body));
            expect(request).not.toHaveProperty("reasoning_effort");
            expect(request).not.toHaveProperty("thinking_budget");
            if (id === "qwen") expect(request.preserve_thinking).toBe(true);
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

test("reasoning replay is scoped to source, endpoint and model without mutating History", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.HICODE_REPLAY_TEST_KEY = "fixture-key";
        globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => response("original model reasoning", false)) as typeof fetch;
        const user: Message = {role:"user", origin:"user", content:"hello"};
        const first = await createLLMCaller(source)([user], tools, storage, cwd, "qwen3.8-flash", "main");
        const history: Message[] = [user, first.message, {role:"user", origin:"user", content:"continue"}];
        for (const target of [
            {source, model:"qwen3.8-max"},
            {source:{...source, baseUrl:"https://other.test/v1"}, model:"qwen3.8-flash"},
            {source:{...source, id:"deepseek" as const}, model:"qwen3.8-flash"},
            {source, model:"qwen3-coder-plus"},
            {source, model:"vendor/custom-alias"},
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
        await createLLMCaller(source)(history, tools, storage, cwd, "qwen3.8-flash", "main");
        expect(first.message).toMatchObject({reasoning:{content:"original model reasoning"}});
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
