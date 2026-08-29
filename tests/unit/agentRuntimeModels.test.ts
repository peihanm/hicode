import {afterEach, describe, expect, test} from "bun:test";
import {createAgentRuntime} from "../../src/runtime/agentRuntime.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/index.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestSettings} from "../helpers/runtimeResources.js";

const originalFetch = globalThis.fetch;
const originalDashscopeKey = process.env.DASHSCOPE_API_KEY;
const originalGlmKey = process.env.GLM_API_KEY;
const originalDeepseekKey = process.env.DEEPSEEK_API_KEY;

function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    restore("DASHSCOPE_API_KEY", originalDashscopeKey);
    restore("GLM_API_KEY", originalGlmKey);
    restore("DEEPSEEK_API_KEY", originalDeepseekKey);
});

function textStream(content: string): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                    choices: [{delta: {content}, finish_reason: "stop"}],
                    usage: {
                        prompt_tokens: 10,
                        completion_tokens: 2,
                        total_tokens: 12,
                    },
                })}\n\n`
            ));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    }), {status: 200});
}

describe("AgentRuntime model targets", () => {
    test("inherit 使用 primary Provider，fast 使用独立 Provider", async () => {
        await withTempProject(async (cwd) => {
            process.env.DASHSCOPE_API_KEY = "qwen-key";
            process.env.GLM_API_KEY = "glm-key";
            process.env.DEEPSEEK_API_KEY = "deepseek-key";
            const calls: Array<{url: string; model: string; authorization: string}> = [];

            globalThis.fetch = (async (input, init) => {
                const body = JSON.parse(String(init?.body)) as {model: string};
                calls.push({
                    url: String(input),
                    model: body.model,
                    authorization:
                        new Headers(init?.headers).get("Authorization") ?? "",
                });
                return textStream(`reply from ${body.model}`);
            }) as typeof fetch;

            const memory = createTestMemoryRuntime(cwd, {enabled: false});
            const runtime = createAgentRuntime({
                fastModel: {
                    source: "glm",
                    provider: "glm",
                    model: "glm-fast-test",
                    label: "GLM Fast Test",
                },
                sources: {
                    ...createTestSettings().sources,
                    qwen: {
                        ...createTestSettings().sources.qwen,
                        baseUrl: "https://qwen.test/v1",
                    },
                    glm: {
                        ...createTestSettings().sources.glm,
                        baseUrl: "https://glm.test/v1",
                    },
                    deepseek: {
                        ...createTestSettings().sources.deepseek,
                        baseUrl: "https://deepseek.test/v1",
                    },
                },
                subagents: BUILTIN_SUBAGENT_REGISTRY,
                memory,
            });
            const parentContext = createTestContext(cwd, {
                model: "qwen-primary-test",
                provider: "qwen",
                fastModel: "glm-fast-test",
                fastProvider: "glm",
            });
            const runSubagent = runtime.createSubagentRunner({
                parentContext,
                onEvent() {},
            });

            const fast = await runSubagent({
                agentType: "Explore",
                description: "快速调查",
                prompt: "直接总结",
                parentToolCallId: "fast-call",
            });
            const primary = await runSubagent({
                agentType: "GeneralPurpose",
                description: "主力实现",
                prompt: "直接总结",
                parentToolCallId: "primary-call",
            });
            const deepseekContext = createTestContext(cwd, {
                model: "deepseek-v4-pro",
                provider: "deepseek",
                fastModel: "glm-fast-test",
                fastProvider: "glm",
            });
            const runDeepseekSubagent = runtime.createSubagentRunner({
                parentContext: deepseekContext,
                onEvent() {},
            });
            const switchedPrimary = await runDeepseekSubagent({
                agentType: "GeneralPurpose",
                description: "切换后的主力实现",
                prompt: "直接总结",
                parentToolCallId: "switched-primary-call",
            });

            expect(fast.reply).toBe("reply from glm-fast-test");
            expect(primary.reply).toBe("reply from qwen-primary-test");
            expect(switchedPrimary.reply).toBe("reply from deepseek-v4-pro");
            expect(calls).toEqual([
                {
                    url: "https://glm.test/v1/chat/completions",
                    model: "glm-fast-test",
                    authorization: "Bearer glm-key",
                },
                {
                    url: "https://qwen.test/v1/chat/completions",
                    model: "qwen-primary-test",
                    authorization: "Bearer qwen-key",
                },
                {
                    url: "https://deepseek.test/v1/chat/completions",
                    model: "deepseek-v4-pro",
                    authorization: "Bearer deepseek-key",
                },
            ]);
            await memory.close();
        });
    });
});
