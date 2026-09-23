import {afterEach, expect, test} from "bun:test";
import {createLLMCaller} from "../../src/llm/index.js";
import type {LLMSourceConnection, Message, OpenAITool} from "../../src/llm/types.js";
import {createSessionPersistence, loadSession} from "../../src/session/storage.js";
import {decodeSessionContentBlock} from "../../src/session/codec.js";
import {estimateMessageTokens} from "../../src/context/tokens.js";
import {getModelInputBudget} from "../../src/context/window.js";
import {resolveHiCodeSettings} from "../../src/settings/resolve.js";
import {listConfiguredPrimaryModels} from "../../src/llm/modelCatalog.js";
import {withTempProject} from "../helpers/tempProject.js";

const model = "nvidia/nemotron-3-super-120b-a12b:free";
const source: LLMSourceConnection = {id: "openrouter", label: "OpenRouter", apiKeyEnv: "HICODE_OPENROUTER_TEST_KEY"};
const tools: OpenAITool[] = [{type: "function", function: {name: "add_integers", description: "Add", parameters: {type: "object"}}}];
const originalFetch = globalThis.fetch;
const originalKey = process.env.HICODE_OPENROUTER_TEST_KEY;
afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.HICODE_OPENROUTER_TEST_KEY;
    else process.env.HICODE_OPENROUTER_TEST_KEY = originalKey;
});
function sse(chunks: unknown[]) {
    const text = ": OPENROUTER PROCESSING\n\n" + chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream<Uint8Array>({start(controller) {
        // Exercise splits inside UTF-8 and JSON, not just at event boundaries.
        for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
        controller.close();
    }}));
}

test("OpenRouter catalog uses its own credential and the free model's actual context budget", () => {
    const settings = resolveHiCodeSettings([], {source: "openrouter", model}).values;
    expect(settings.sources.openrouter.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    expect(settings.models.primary).toMatchObject({source: "openrouter", model});
    expect(listConfiguredPrimaryModels(settings.sources, {OPENROUTER_API_KEY: "fixture"})).toEqual([
        {source: "openrouter", model, label: "Nemotron 3 Super (free)"},
    ]);
    expect(listConfiguredPrimaryModels(settings.sources, {})).toEqual([]);
    expect(getModelInputBudget(model)).toBe(262_144 - 20_000);
});

test("streamed tool arguments and exact reasoning fragments survive restore and replay only to the same target", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.HICODE_OPENROUTER_TEST_KEY = "fixture-openrouter-key";
        const details = [
            {type: "reasoning.text", text: "先算", index: 0, format: "unknown", signature: null},
            {type: "reasoning.text", text: "加法", index: 0, format: "unknown", signature: "signed"},
            {type: "reasoning.encrypted", data: "opaque-fixture", index: 1, id: "r1"},
        ];
        let requests = 0;
        globalThis.fetch = (async (input, init) => {
            expect(String(input)).toBe("https://openrouter.ai/api/v1/chat/completions");
            const body = JSON.parse(String(init?.body));
            expect(body).toMatchObject({model, stream: true, tool_choice: "auto", provider: {require_parameters: true}});
            for (const key of ["models", "enable_thinking", "preserve_thinking", "thinking", "reasoning_effort"]) expect(body).not.toHaveProperty(key);
            if (requests++ === 0) return sse([
                {choices: [{delta: {reasoning: "先算", reasoning_details: [details[0]]}}]},
                {choices: [{delta: {reasoning: "加法", reasoning_details: details.slice(1)}}]},
                {choices: [{delta: {tool_calls: [{index: 0, id: "add-1", type: "function", function: {name: "add_integers", arguments: '{"a":19,'}}]}}]},
                {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '"b":23}'}}]}, finish_reason: "tool_calls"}]},
                {choices: [{delta: {}, finish_reason: "tool_calls"}], usage: {prompt_tokens: 333, completion_tokens: 63, total_tokens: 396}},
            ]);
            const assistant = body.messages.find((message: {role: string}) => message.role === "assistant");
            expect(assistant).toMatchObject({reasoning: "先算加法", reasoning_details: details});
            expect(assistant).not.toHaveProperty("reasoning_content");
            expect(assistant).not.toHaveProperty("scope");
            expect(body.messages.find((message: {role: string}) => message.role === "tool")).toEqual({role: "tool", tool_call_id: "add-1", content: '{"result":42}'});
            return sse([{choices: [{delta: {content: "42"}, finish_reason: "stop"}]}]);
        }) as typeof fetch;
        const caller = createLLMCaller(source);
        const user: Message = {role: "user", origin: "user", content: "Add 19 and 23"};
        const first = await caller([user], tools, storage, cwd, model, "main");
        expect(first.toolCalls[0]?.function.arguments).toBe('{"a":19,"b":23}');
        expect(first.usage.total_tokens).toBe(396);
        expect(first.message).toMatchObject({reasoning: {format: "openrouter", content: "先算加法", details}});
        expect(estimateMessageTokens(first.message)).toBeGreaterThan(100);
        const history: Message[] = [user, first.message, {role: "tool", tool_call_id: "add-1", content: '{"result":42}'}];
        await createSessionPersistence(storage, cwd, "router").save({cwd, sessionId: "router", model, history, todos: [], permissionMode: "ask", collaborationMode: "build"});
        const restored = loadSession(storage, cwd, "router", model);
        expect(restored?.history.filter(message => message.role !== "system")).toEqual(history.filter(message => message.role !== "system"));
        expect((await caller(restored!.history, tools, storage, cwd, model, "main")).message).toEqual({role: "assistant", content: "42"});
        expect(requests).toBe(2);
        for (const target of [
            {source: {...source, baseUrl: "https://other.test/v1"}, model},
            {source, model: "other/model"},
            {source: {...source, id: "deepseek" as const}, model},
        ]) {
            globalThis.fetch = (async (_input, init) => {
                const assistant = JSON.parse(String(init?.body)).messages[1];
                expect(assistant).not.toHaveProperty("reasoning");
                expect(assistant).not.toHaveProperty("reasoning_details");
                expect(assistant).not.toHaveProperty("reasoning_content");
                return sse([{choices: [{delta: {content: "done"}, finish_reason: "stop"}]}]);
            }) as typeof fetch;
            await createLLMCaller(target.source)(history, tools, storage, cwd, target.model, "main");
        }
        expect(first.message).toMatchObject({reasoning: {details}});
    });
});

test("details-only replies persist; malformed details and HTTP-200 provider errors fail without exposing secrets", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.HICODE_OPENROUTER_TEST_KEY = "fixture-openrouter-secret";
        const call = createLLMCaller(source);
        const user: Message = {role: "user", origin: "user", content: "Hi"};
        globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => sse([{choices: [{delta: {reasoning_details: [{type: "reasoning.encrypted", data: "opaque"}], content: "Hi"}, finish_reason: "stop"}]}])) as typeof fetch;
        const reply = await call([user], [], storage, cwd, model, "main");
        if (reply.message.role !== "assistant") throw new Error("Expected assistant");
        expect(decodeSessionContentBlock({kind: "message", value: reply.message})).toEqual({kind: "message", value: reply.message});
        let requests = 0;
        globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {requests++; return sse([{error: {code: 429, message: "limited fixture-openrouter-secret"}, choices: [{finish_reason: "error"}]}]);}) as typeof fetch;
        try { await call([user], [], storage, cwd, model, "main"); throw new Error("Expected rejection"); }
        catch (error) {
            expect(String(error)).toContain("429");
            expect(String(error)).not.toContain("fixture-openrouter-secret");
        }
        expect(requests).toBe(1);
        globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => sse([{choices: [{delta: {reasoning_details: [{type: "reasoning.text", text: 12}]}}]}])) as typeof fetch;
        await expect(call([user], [], storage, cwd, model, "main")).rejects.toThrow("Invalid stream reasoning_details");
    });
});
