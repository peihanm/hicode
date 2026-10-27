import {afterEach, expect, test} from "bun:test";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {createLLMCaller} from "../../src/llm/index.js";
import {resolveHiCodeSettings} from "../../src/settings/resolve.js";
import {withTempProject} from "../helpers/tempProject.js";
import {listPromptLogs} from "../helpers/promptLogs.js";
import {getPromptLogDirectory} from "../../src/persistence/layout.js";
import type {Message} from "../../src/llm/types.js";
import sharp from "sharp";
import {prepareImage} from "../../src/images/prepare.js";
import {imageAssetId} from "../../src/images/persist.js";

const originalFetch = globalThis.fetch;
const keys = ["ARK_AGENT_PLAN_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "DEEPSEEK_API_KEY"] as const;
const previous = keys.map(key => process.env[key]);
afterEach(() => {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
});
const success = () => new Response('data: {"choices":[{"delta":{"reasoning_content":"review evidence","content":"done"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\ndata: [DONE]\n\n');
const user: Message = {role:"user", origin:"user", content:"inspect"};

test("Ark's declared visual model sends verified image bytes and rejects undeclared image capability", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.ARK_AGENT_PLAN_API_KEY = "fixture";
        const png = await sharp({create:{width:8,height:8,channels:3,background:"blue"}}).png().toBuffer();
        const prepared = await prepareImage(png, new AbortController().signal);
        const message: Message = {role:"user",origin:"user",content:[{type:"image",imageId:imageAssetId(prepared.image),image:prepared.image}]};
        let calls = 0;
        globalThis.fetch = (async (_input, init) => {
            calls++;
            const body = JSON.parse(String(init?.body));
            expect(body.messages[0].content).toEqual([{type:"image_url",image_url:{url:`data:image/png;base64,${prepared.data.toString("base64")}`}}]);
            return success();
        }) as typeof fetch;
        const source = resolveHiCodeSettings([]).values.sources["ark-agent-plan"];
        await createLLMCaller(source)({messages: [message], tools: [], storage, cwd, model: "deepseek-v4.1-flash", kind: "main", readImage: async () => prepared.data});
        await expect(createLLMCaller({...source,models:[]})({messages: [message], tools: [], storage, cwd, model: "deepseek-v4.1-flash", kind: "main", readImage: async () => prepared.data})).rejects.toThrow("has no image capability");
        expect(calls).toBe(1);
    });
});

test("Ark uses its dedicated endpoint and key, keeps explicit effort on retry, and redacts the key", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.ARK_AGENT_PLAN_API_KEY = "ark-fixture-secret";
        process.env.QWEN_TOKEN_PLAN_API_KEY = "qwen-fixture-secret";
        process.env.DEEPSEEK_API_KEY = "deepseek-fixture-secret";
        const requests: {url:string; authorization:string|null; body:Record<string, unknown>}[] = [];
        globalThis.fetch = (async (input, init) => {
            requests.push({url:String(input), authorization:new Headers(init?.headers).get("authorization"), body:JSON.parse(String(init?.body))});
            if (requests.length === 1) return new Response('data: {"error":{"code":"temporary_failure","message":"retry"}}\n\n');
            return success();
        }) as typeof fetch;
        const source = resolveHiCodeSettings([]).values.sources["ark-agent-plan"];
        const caller = createLLMCaller(source);
        const result = await caller({messages: [user], tools: [], storage, cwd, model: "deepseek-v4.1-flash", kind: "main", reasoning: "max"});
        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(request.url).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions");
            expect(request.authorization).toBe("Bearer ark-fixture-secret");
            expect(request.body).toMatchObject({model:"deepseek-v4.1-flash", reasoning_effort:"max", stream:true, stream_options:{include_usage:true}});
            for (const field of ["thinking", "enable_thinking", "preserve_thinking", "provider"]) expect(request.body).not.toHaveProperty(field);
        }
        expect(result.usage).toMatchObject({prompt_tokens:100, completion_tokens:10, total_tokens:110});
        const directory = getPromptLogDirectory(storage, cwd);
        for (const file of await listPromptLogs(directory)) expect(await readFile(join(directory, file), "utf8")).not.toContain("ark-fixture-secret");
        delete process.env.ARK_AGENT_PLAN_API_KEY;
        await expect(caller({messages: [user], tools: [], storage, cwd, model: "deepseek-v4.1-flash", kind: "main"})).rejects.toThrow("Missing ARK_AGENT_PLAN_API_KEY");
        expect(requests).toHaveLength(2);
    });
});

test("Ark explicit off encodes none in main and review requests without changing history", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.ARK_AGENT_PLAN_API_KEY = "fixture";
        const caller = createLLMCaller(resolveHiCodeSettings([]).values.sources["ark-agent-plan"]);
        const bodies: Record<string, unknown>[] = [];
        globalThis.fetch = (async (_input, init) => {bodies.push(JSON.parse(String(init?.body))); return success();}) as typeof fetch;
        const first = await caller({messages: [user], tools: [], storage, cwd, model: "deepseek-v4.1-flash", kind: "main"});
        expect(bodies[0]).not.toHaveProperty("reasoning_effort");
        const history: Message[] = [user, first.message];
        const original = structuredClone(history);
        for (const kind of ["main", "task_review"] as const) {
            const reply = await caller({messages: history, tools: [], storage, cwd, model: "deepseek-v4.1-flash", kind, reasoning: "off"});
            const body = bodies.at(-1)!;
            expect(body.reasoning_effort).toBe("none");
            expect(body.messages).toEqual([{role:"user",content:"inspect"},{role:"assistant",content:"done"}]);
            expect(reply.message).not.toHaveProperty("reasoning");
        }
        expect(history).toEqual(original);
        await caller({messages: history, tools: [], storage, cwd, model: "deepseek-v4.1-flash", kind: "main"});
        expect(bodies.at(-1)!.messages).toEqual([{role:"user",content:"inspect"},{role:"assistant",content:"done",reasoning_content:"review evidence"}]);
        const count = bodies.length;
        await expect(caller({messages: [user], tools: [], storage, cwd, model: "deepseek-v4.1-flash", kind: "main", reasoning: "medium"})).rejects.toThrow("not supported");
        expect(bodies).toHaveLength(count);
    });
});

test("Ark GLM Flash enforces thinking, replays tool reasoning, and keeps review reasoning isolated", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.ARK_AGENT_PLAN_API_KEY = "fixture";
        const caller = createLLMCaller(resolveHiCodeSettings([]).values.sources["ark-agent-plan"]);
        const bodies: Record<string, unknown>[] = [];
        globalThis.fetch = (async (_input, init) => {
            const body = JSON.parse(String(init?.body)); bodies.push(body);
            expect(body.thinking).toEqual({type:"enabled"});
            expect(body).not.toHaveProperty("enable_thinking");
            expect(body).not.toHaveProperty("preserve_thinking");
            return bodies.length === 1 ? new Response('data: {"choices":[{"delta":{"reasoning_content":"inspect first","tool_calls":[{"index":0,"id":"read-1","type":"function","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n') : success();
        }) as typeof fetch;
        const tools = [{type:"function" as const,function:{name:"read_file",description:"Read",parameters:{type:"object"}}}];
        const first = await caller({messages: [user], tools, storage, cwd, model: "glm-5.3-flash", kind: "main"});
        expect(bodies[0]).not.toHaveProperty("reasoning_effort");
        const history:Message[]=[user,first.message,{role:"tool",tool_call_id:"read-1",content:"file contents"}];
        await caller({messages: history, tools, storage, cwd, model: "glm-5.3-flash", kind: "main", reasoning: "max"});
        expect(bodies[1]?.reasoning_effort).toBe("max");
        expect(bodies[1]?.messages).toContainEqual(expect.objectContaining({role:"assistant",reasoning_content:"inspect first"}));
        const review=await caller({messages: history, tools, storage, cwd, model: "glm-5.3-flash", kind: "task_review", reasoning: "max"});
        expect(bodies[2]).toMatchObject({reasoning_effort:"max"});
        expect(bodies[2]).not.toHaveProperty("max_tokens");
        expect((bodies[2]?.messages as Record<string,unknown>[]).every(message=>!('reasoning_content' in message))).toBe(true);
        expect(review.message).not.toHaveProperty("reasoning");
        const count=bodies.length;
        await expect(caller({messages: [user], tools, storage, cwd, model: "glm-5.3-flash", kind: "main", reasoning: "off"})).rejects.toThrow("not supported");
        expect(bodies).toHaveLength(count);
    });
});
