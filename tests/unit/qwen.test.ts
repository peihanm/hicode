import {afterEach, describe, expect, test} from "bun:test";
import {createLLMCaller} from "../../src/llm/index.js";
import {
    createQwenRequestFields,
    qwenProvider,
} from "../../src/llm/providers/qwen.js";
import {createTestStorage, withTempProject} from "../helpers/tempProject.js";
import type {LLMCallOptions, LLMProvider} from "../../src/llm/types.js";

const QWEN_SOURCE = {
    id: "qwen" as const,
    label: "Qwen",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrl: "https://qwen.test/v1",
};

function callQwenProvider(
    provider: LLMProvider,
    options: Omit<LLMCallOptions, "storage">
) {
    return provider.call({
        ...options,
        storage: createTestStorage(options.cwd),
    }, QWEN_SOURCE);
}

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.DASHSCOPE_API_KEY;

afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = originalApiKey;
});

describe("Qwen provider", () => {
    test("请求流式 Function Calling，并读取 finish_reason 后的 usage 尾包", async () => {
        await withTempProject(async (cwd) => {
            process.env.DASHSCOPE_API_KEY = "test-dashscope-token";
            let requestedUrl = "";
            let requestBody: Record<string, unknown> | undefined;
            const encoder = new TextEncoder();

            globalThis.fetch = (async (input, init) => {
                requestedUrl = String(input);
                requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
                const events = [
                    {
                        usage: null,
                        choices: [{
                            delta: {
                                reasoning_content: "准备调用工具",
                                tool_calls: [{
                                    index: 0,
                                    id: "call-qwen-1",
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
                        usage: null,
                        choices: [{
                            delta: {
                                tool_calls: [{
                                    index: 0,
                                    function: {arguments: "index.ts\"}"},
                                }],
                            },
                            finish_reason: "tool_calls",
                        }],
                    },
                    {
                        choices: [],
                        usage: {
                            prompt_tokens: 80,
                            completion_tokens: 20,
                            total_tokens: 100,
                        },
                    },
                ];
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (const event of events) {
                            controller.enqueue(encoder.encode(
                                `data: ${JSON.stringify(event)}\n\n`
                            ));
                        }
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                });
                return new Response(body, {status: 200});
            }) as typeof fetch;

            const result = await callQwenProvider(qwenProvider, {
                messages: [{role: "user", origin: "user" as const, content: "读取入口"}],
                tools: [{
                    type: "function",
                    function: {
                        name: "read_file",
                        description: "读取文件",
                        parameters: {type: "object"},
                    },
                }],
                cwd,
                model: "qwen3.6-plus",
                kind: "main",
            });

            expect(requestedUrl).toBe("https://qwen.test/v1/chat/completions");
            expect(requestBody).toMatchObject({
                model: "qwen3.6-plus",
                stream: true,
                enable_thinking: true,
                parallel_tool_calls: true,
                stream_options: {include_usage: true},
            });
            expect(requestBody).not.toHaveProperty("tool_stream");
            expect(result.toolCalls).toEqual([{
                id: "call-qwen-1",
                type: "function",
                function: {
                    name: "read_file",
                    arguments: '{"path":"src/index.ts"}',
                },
            }]);
            expect(result.usage).toEqual({
                prompt_tokens: 80,
                completion_tokens: 20,
                total_tokens: 100,
            });
        });
    });

    test("Coder 模型不发送不支持的 thinking 字段，无工具时不发送并行开关", () => {
        expect(createQwenRequestFields("qwen3-coder-next", false)).toEqual({
            stream_options: {include_usage: true},
        });
        expect(createQwenRequestFields("qwen3-coder-plus", true)).toEqual({
            stream_options: {include_usage: true},
            parallel_tool_calls: true,
        });
    });

    test("切换 Provider 时不发送 DeepSeek 专属 reasoning_content", async () => {
        await withTempProject(async (cwd) => {
            process.env.DASHSCOPE_API_KEY = "test-dashscope-token";
            let requestBody: Record<string, unknown> = {};
            const encoder = new TextEncoder();
            globalThis.fetch = (async (_input, init) => {
                requestBody = JSON.parse(
                    String(init?.body)
                ) as Record<string, unknown>;
                return new Response(new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode(
                            `data: ${JSON.stringify({
                                choices: [{
                                    delta: {content: "ok"},
                                    finish_reason: "stop",
                                }],
                                usage: {
                                    prompt_tokens: 10,
                                    completion_tokens: 1,
                                    total_tokens: 11,
                                },
                            })}\n\n`
                        ));
                        controller.enqueue(
                            encoder.encode("data: [DONE]\n\n")
                        );
                        controller.close();
                    },
                }), {status: 200});
            }) as typeof fetch;

            await callQwenProvider(qwenProvider, {
                messages: [
                    {role: "user", origin: "user" as const, content: "继续"},
                    {
                        role: "assistant",
                        content: null,
                        reasoning_content: "DeepSeek private reasoning",
                        tool_calls: [{
                            id: "call-1",
                            type: "function",
                            function: {
                                name: "read_file",
                                arguments: '{"path":"src/index.ts"}',
                            },
                        }],
                    },
                    {
                        role: "tool",
                        tool_call_id: "call-1",
                        content: "content",
                    },
                ],
                tools: [],
                cwd,
                model: "qwen3.6-plus",
                kind: "main",
            });

            expect(JSON.stringify(requestBody)).not.toContain(
                "reasoning_content"
            );
        });
    });

    test("只接受 Qwen 模型，并在缺少百炼 Key 时给出明确错误", async () => {
        expect(qwenProvider.supports("qwen3.6-plus")).toBe(true);
        expect(qwenProvider.supports("glm-5.2")).toBe(false);
        delete process.env.DASHSCOPE_API_KEY;

        await expect(callQwenProvider(qwenProvider, {
            messages: [{role: "user", origin: "user" as const, content: "hello"}],
            tools: [],
            cwd: process.cwd(),
            model: "qwen3.6-plus",
            kind: "main",
        })).rejects.toThrow("缺少 DASHSCOPE_API_KEY");

        const callQwen = createLLMCaller(QWEN_SOURCE);
        await expect(callQwen(
            [{role: "user", origin: "user" as const, content: "hello"}],
            [],
            createTestStorage(process.cwd()),
            process.cwd(),
            "glm-5.2",
            "main"
        )).rejects.toThrow("模型来源 Qwen 不支持模型 glm-5.2");
    });
});
