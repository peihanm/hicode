import {afterEach, describe, expect, test} from "bun:test";
import {createAgentRuntime} from "../../src/runtime/agentRuntime.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/index.js";
import {createTestContext} from "../helpers/testContext.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";
import {withTempProject} from "../helpers/tempProject.js";

const originalFetch = globalThis.fetch;
const originalDashscopeKey = process.env.DASHSCOPE_API_KEY;
const originalJeniyaKey = process.env.JENIYA_API_KEY;
const originalQwenBaseUrl = process.env.QWEN_BASE_URL;
const originalJeniyaBaseUrl = process.env.JENIYA_BASE_URL;

function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    restore("DASHSCOPE_API_KEY", originalDashscopeKey);
    restore("JENIYA_API_KEY", originalJeniyaKey);
    restore("QWEN_BASE_URL", originalQwenBaseUrl);
    restore("JENIYA_BASE_URL", originalJeniyaBaseUrl);
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
            process.env.JENIYA_API_KEY = "jeniya-key";
            process.env.QWEN_BASE_URL = "https://qwen.test/v1";
            process.env.JENIYA_BASE_URL = "https://jeniya.test/v1";
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
                models: {
                    primary: {provider: "qwen", model: "qwen-primary-test"},
                    fast: {provider: "jeniya", model: "glm-fast-test"},
                },
                subagents: BUILTIN_SUBAGENT_REGISTRY,
                memory,
            });
            const parentContext = createTestContext(cwd, {
                model: "qwen-primary-test",
                fastModel: "glm-fast-test",
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

            expect(fast.reply).toBe("reply from glm-fast-test");
            expect(primary.reply).toBe("reply from qwen-primary-test");
            expect(calls).toEqual([
                {
                    url: "https://jeniya.test/v1/chat/completions",
                    model: "glm-fast-test",
                    authorization: "Bearer jeniya-key",
                },
                {
                    url: "https://qwen.test/v1/chat/completions",
                    model: "qwen-primary-test",
                    authorization: "Bearer qwen-key",
                },
            ]);
            await memory.close();
        });
    });
});
