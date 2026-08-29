import {afterEach, describe, expect, test} from "bun:test";
import {createLLMCaller} from "../../src/llm/index.js";
import {
    createDeepSeekRequestFields,
    deepseekProvider,
} from "../../src/llm/providers/deepseek.js";
import {withTempProject} from "../helpers/tempProject.js";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.DEEPSEEK_API_KEY;
const originalBaseUrl = process.env.DEEPSEEK_BASE_URL;
const originalReasoningEffort = process.env.PILLAR_REASONING_EFFORT;

function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    restore("DEEPSEEK_API_KEY", originalApiKey);
    restore("DEEPSEEK_BASE_URL", originalBaseUrl);
    restore("PILLAR_REASONING_EFFORT", originalReasoningEffort);
});

function stream(events: readonly Record<string, unknown>[]): Response {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            for (const event of events) {
                controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify(event)}\n\n`
                ));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    }), {status: 200});
}

describe("DeepSeek provider", () => {
    test("流式工具调用保留 reasoning_content 并在下一次请求回传", async () => {
        await withTempProject(async (cwd) => {
            process.env.DEEPSEEK_API_KEY = "deepseek-token";
            process.env.DEEPSEEK_BASE_URL = "https://deepseek.test/v1/";
            process.env.PILLAR_REASONING_EFFORT = "max";
            const requests: Array<Record<string, unknown>> = [];
            let fetchCalls = 0;

            globalThis.fetch = (async (input, init) => {
                expect(String(input)).toBe(
                    "https://deepseek.test/v1/chat/completions"
                );
                expect(
                    new Headers(init?.headers).get("Authorization")
                ).toBe("Bearer deepseek-token");
                requests.push(
                    JSON.parse(String(init?.body)) as Record<string, unknown>
                );
                fetchCalls += 1;
                if (fetchCalls === 1) {
                    return stream([
                        {
                            choices: [{
                                delta: {reasoning_content: "需要先读取文件"},
                            }],
                        },
                        {
                            choices: [{
                                delta: {
                                    tool_calls: [{
                                        index: 0,
                                        id: "call-deepseek-1",
                                        type: "function",
                                        function: {
                                            name: "read_file",
                                            arguments: "{\"path\":\"src/",
                                        },
                                    }],
                                },
                            }],
                        },
                        {
                            choices: [{
                                delta: {
                                    tool_calls: [{
                                        index: 0,
                                        function: {arguments: "index.ts\"}"},
                                    }],
                                },
                                finish_reason: "tool_calls",
                            }],
                            usage: {
                                prompt_tokens: 30,
                                completion_tokens: 10,
                                total_tokens: 40,
                            },
                        },
                    ]);
                }
                return stream([{
                    choices: [{
                        delta: {
                            reasoning_content: "已经获得文件内容",
                            content: "读取完成",
                        },
                        finish_reason: "stop",
                    }],
                    usage: {
                        prompt_tokens: 50,
                        completion_tokens: 8,
                        total_tokens: 58,
                    },
                }]);
            }) as typeof fetch;

            const first = await deepseekProvider.call({
                messages: [{role: "user", content: "读取入口"}],
                tools: [{
                    type: "function",
                    function: {
                        name: "read_file",
                        description: "读取文件",
                        parameters: {type: "object"},
                    },
                }],
                cwd,
                model: "deepseek-v4-pro",
                kind: "main",
            });

            expect(requests[0]).toMatchObject({
                model: "deepseek-v4-pro",
                stream: true,
                thinking: {type: "enabled"},
                reasoning_effort: "max",
                stream_options: {include_usage: true},
            });
            expect(requests[0]).not.toHaveProperty("tool_stream");
            expect(requests[0]).not.toHaveProperty("tool_choice");
            expect(first.message).toEqual({
                role: "assistant",
                content: null,
                reasoning_content: "需要先读取文件",
                tool_calls: [{
                    id: "call-deepseek-1",
                    type: "function",
                    function: {
                        name: "read_file",
                        arguments: '{"path":"src/index.ts"}',
                    },
                }],
            });

            const second = await deepseekProvider.call({
                messages: [
                    {role: "user", content: "读取入口"},
                    first.message,
                    {
                        role: "tool",
                        tool_call_id: "call-deepseek-1",
                        content: "file content",
                    },
                ],
                tools: [],
                cwd,
                model: "deepseek-v4-pro",
                kind: "main",
            });

            expect(requests[1]).toMatchObject({
                messages: [
                    {role: "user", content: "读取入口"},
                    {
                        role: "assistant",
                        reasoning_content: "需要先读取文件",
                        tool_calls: [{id: "call-deepseek-1"}],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call-deepseek-1",
                        content: "file content",
                    },
                ],
            });
            expect(second.message).toEqual({
                role: "assistant",
                content: "读取完成",
            });
        });
    });

    test("只接受 DeepSeek 模型并使用独立 Key", async () => {
        expect(deepseekProvider.supports("deepseek-v4-pro")).toBe(true);
        expect(deepseekProvider.supports("deepseek-v4-flash")).toBe(true);
        expect(deepseekProvider.supports("glm-5.2")).toBe(false);
        delete process.env.DEEPSEEK_API_KEY;

        await expect(deepseekProvider.call({
            messages: [{role: "user", content: "hello"}],
            tools: [],
            cwd: process.cwd(),
            model: "deepseek-v4-pro",
            kind: "main",
        })).rejects.toThrow("缺少 DEEPSEEK_API_KEY");

        await expect(createLLMCaller("deepseek")(
            [{role: "user", content: "hello"}],
            [],
            process.cwd(),
            "qwen3.6-plus",
            "main"
        )).rejects.toThrow(
            "Provider deepseek 不支持模型 qwen3.6-plus"
        );
    });

    test("推理强度沿用统一配置并拒绝无效值", () => {
        delete process.env.PILLAR_REASONING_EFFORT;
        expect(createDeepSeekRequestFields()).toMatchObject({
            reasoning_effort: "high",
        });
        process.env.PILLAR_REASONING_EFFORT = "max";
        expect(createDeepSeekRequestFields()).toMatchObject({
            reasoning_effort: "max",
        });
        process.env.PILLAR_REASONING_EFFORT = "medium";
        expect(() => createDeepSeekRequestFields()).toThrow(
            "PILLAR_REASONING_EFFORT 只支持 high 或 max"
        );
    });
});
