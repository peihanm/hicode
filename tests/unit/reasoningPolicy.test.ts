import {afterEach, expect, test} from "bun:test";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {createLLMCaller} from "../../src/llm/index.js";
import {reasoningCapability, type ReasoningEffort} from "../../src/llm/reasoningPolicy.js";
import {resolveHiCodeSettings} from "../../src/settings/resolve.js";
import {hicodeHostSettingsSchema} from "../../src/settings/schema.js";
import type {LoadedSettingsDocument} from "../../src/settings/types.js";
import {getPromptLogDirectory} from "../../src/persistence/layout.js";
import {withTempProject} from "../helpers/tempProject.js";
import {listPromptLogs} from "../helpers/promptLogs.js";

const originalFetch = globalThis.fetch;
const keys = ["DASHSCOPE_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "DEEPSEEK_API_KEY", "GLM_API_KEY"] as const;
const previous = keys.map(key => process.env[key]);
afterEach(() => {
    globalThis.fetch = originalFetch;
    keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
});
const success = () => new Response('data: {"choices":[{"delta":{"reasoning_content":"thinking","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');

test("canonical choices reject aliases, unsupported levels and duplicate preferences; higher default masks lower max", () => {
    const doc = (source: "user" | "project", effort: ReasoningEffort): LoadedSettingsDocument => ({source, path: "/fixture", value: {models: {reasoning: [{source: "qwen-token-plan", model: "deepseek-v4.1-flash", effort}]}}});
    expect(reasoningCapability("qwen", "qwen3.8-flash")?.efforts).toEqual(["default", "off", "low", "medium", "xhigh"]);
    expect(reasoningCapability("qwen-token-plan", "deepseek-v4.1-flash")?.efforts).toEqual(["default", "off", "low", "high", "max"]);
    expect(reasoningCapability("glm", "glm-5.2")?.efforts).toEqual(["default", "off", "high", "max"]);
    expect(reasoningCapability("glm", "glm-5.3")?.efforts).toEqual(["default", "low", "high", "max"]);
    expect(reasoningCapability("glm", "glm-5.3-flash")?.efforts).toEqual(["default", "low", "high", "max"]);
    expect(reasoningCapability("qwen", "qwen3.8-flash-unconfirmed-alias")).toBeUndefined();
    const loaded = resolveHiCodeSettings([doc("user", "max"), doc("project", "default")]).values;
    expect(loaded.models.reasoning).toEqual([{source: "qwen-token-plan", model: "deepseek-v4.1-flash", effort: "default"}]);
    const duplicate = doc("user", "low"); duplicate.value.models!.reasoning!.push({...duplicate.value.models!.reasoning![0]!});
    expect(() => resolveHiCodeSettings([duplicate])).toThrow("Duplicate");
    expect(() => resolveHiCodeSettings([doc("user", "medium")])).toThrow("not supported");
    const unknown = doc("user", "low"); unknown.value.models!.reasoning![0]!.model = "missing";
    expect(() => resolveHiCodeSettings([unknown])).toThrow("not configured");
    expect(hicodeHostSettingsSchema.safeParse({models: {reasoning: [{source: "qwen", model: "qwen3.8-flash", effort: "ultra"}]}}).success).toBe(false);
});

for (const [sourceId, model] of [["qwen", "qwen3.8-flash"], ["qwen-token-plan", "qwen3.8-flash"], ["qwen-token-plan", "deepseek-v4.1-flash"], ["deepseek", "deepseek-flash"], ["glm", "glm-5.2"], ["glm", "glm-5.3"], ["glm", "glm-5.3-flash"]] as const) {
    test(`${sourceId}/${model} sends canonical choices and applies the supported task-review policy`, async () => {
        await withTempProject(async (cwd, storage) => {
            const source = resolveHiCodeSettings([]).values.sources[sourceId];
            process.env[source.apiKeyEnv] = "fixture-key";
            const bodies: Record<string, unknown>[] = [];
            globalThis.fetch = (async (_input, init) => {bodies.push(JSON.parse(String(init?.body))); return success();}) as typeof fetch;
            const caller = createLLMCaller(source), messages = [{role: "user" as const, origin: "user" as const, content: "test"}];
            const capability = reasoningCapability(sourceId, model)!;
            const explicitEffort = capability.efforts.at(-1)!;
            for (const effort of capability.efforts) {
                await caller(messages, [], storage, cwd, model, "main", undefined, undefined, undefined, undefined, undefined, effort);
                const body = bodies.at(-1)!;
                expect(body).not.toHaveProperty("thinking_budget");
                if (effort === "default" || effort === "off") expect(body).not.toHaveProperty("reasoning_effort");
                else expect(body.reasoning_effort).toBe(effort);
                if (capability.switch === "thinking") expect(body.thinking).toEqual({type: effort === "off" ? "disabled" : "enabled"});
                else {expect(body.enable_thinking).toBe(effort !== "off"); expect(body).not.toHaveProperty("thinking");}
            }
            await caller(messages, [], storage, cwd, model, "task_review", undefined, undefined, undefined, undefined, undefined, explicitEffort);
            const review = bodies.at(-1)!;
            if (capability.reviewEffort === "off") expect(review).not.toHaveProperty("reasoning_effort");
            else expect(review.reasoning_effort).toBe("low");
            expect(review.max_tokens).toBe(512);
            if (capability.switch === "thinking") expect(review.thinking).toEqual({type: capability.reviewEffort === "off" ? "disabled" : "enabled"}); else expect(review.enable_thinking).toBe(false);
            const directory = getPromptLogDirectory(storage, cwd);
            const files = await listPromptLogs(directory);
            const logs = await Promise.all(files.map(async file => JSON.parse(await readFile(join(directory, file), "utf8"))));
            expect(logs.at(-1).request.reasoningPolicy).toEqual({requested: explicitEffort, effective: capability.reviewEffort});
            expect(JSON.stringify(logs)).not.toContain("fixture-key");
            const unsupported = model.startsWith("qwen") ? "high" : "medium";
            const count = bodies.length;
            await expect(caller(messages, [], storage, cwd, model, "main", undefined, undefined, undefined, undefined, undefined, unsupported)).rejects.toThrow("not supported");
            expect(bodies).toHaveLength(count);
        });
    });
}

test("explicit DeepSeek max stays fixed across a provider stream retry; switching off removes replay", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.DEEPSEEK_API_KEY = "fixture-key";
        const source = resolveHiCodeSettings([]).values.sources.deepseek;
        const bodies: Record<string, unknown>[] = [];
        globalThis.fetch = (async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            if (bodies.length === 1) return new Response('data: {"error":{"code":"temporary_failure","message":"retry"}}\n\n');
            return success();
        }) as typeof fetch;
        const caller = createLLMCaller(source), messages = [{role: "user" as const, origin: "user" as const, content: "test"}];
        const reply = await caller(messages, [], storage, cwd, "deepseek-flash", "main", undefined, undefined, undefined, undefined, undefined, "max");
        expect(bodies).toHaveLength(2);
        for (const body of bodies) expect(body).toMatchObject({reasoning_effort: "max", thinking: {type: "enabled"}});
        await caller([...messages, reply.message], [], storage, cwd, "deepseek-flash", "main", undefined, undefined, undefined, undefined, undefined, "off");
        expect(bodies.at(-1)!.messages).toEqual([{role: "user", content: "test"}, {role: "assistant", content: "done"}]);
        expect(reply.message.role === "assistant" && reply.message.reasoning).toBeTruthy();
    });
});
