import {listPromptLogs} from "../helpers/promptLogs.js";
import {afterEach, describe, expect, test} from "bun:test";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {getPromptLogDirectory} from "../../src/persistence/layout.js";
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
            expect(result.message).toMatchObject({reasoning: {content: "准备调用工具", scope: expect.any(String)}});
            const directory = getPromptLogDirectory(createTestStorage(cwd), cwd);
            const [filename] = await listPromptLogs(directory);
            const logged = JSON.parse(await readFile(join(directory, filename!), "utf8")) as {
                response: {rawResponse: Record<string, unknown>; rawMessage: unknown};
            };
            expect(logged.response.rawResponse.reasoning_content).toBe("准备调用工具");
            expect(logged.response.rawMessage).toMatchObject({reasoning: {content: "准备调用工具"}});
        });
    });

    test.each([
        {label: "absent", reasoning: undefined},
        {label: "null", reasoning: null},
        {label: "empty", reasoning: ""},
        {label: "whitespace", reasoning: " \n"},
        {label: "returned", reasoning: "Inspect α\n诊断 test-dashscope-token"},
    ])("logs optional reasoning separately from text: $label", async ({reasoning}) => {
        await withTempProject(async (cwd) => {
            process.env.DASHSCOPE_API_KEY = "test-dashscope-token";
            let fetchCalls = 0;
            const encoder = new TextEncoder();
            globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
                fetchCalls++;
                const events = [
                    {choices: [{delta: reasoning === undefined ? {} : {reasoning_content: reasoning}}]},
                    {choices: [{delta: {content: "ok"}, finish_reason: "stop"}]},
                ];
                return new Response(new ReadableStream<Uint8Array>({
                    start(controller) {
                        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                        controller.close();
                    },
                }));
            }) as typeof fetch;

            const result = await callQwenProvider(qwenProvider, {
                messages: [{role: "user", origin: "user", content: "hello"}],
                tools: [], cwd, model: "qwen3.8-flash", kind: "main",
            });
            expect(fetchCalls).toBe(1);
            expect(result.message).toEqual({role: "assistant", content: "ok", ...(reasoning?.trim() ? {reasoning: {content: reasoning, scope: expect.any(String)}} : {})});
            const directory = getPromptLogDirectory(createTestStorage(cwd), cwd);
            const filenames = await listPromptLogs(directory);
            expect(filenames).toHaveLength(1);
            const serialized = await readFile(join(directory, filenames[0]!), "utf8");
            const logged = JSON.parse(serialized) as {
                response: {rawResponse: Record<string, unknown>; rawMessage: unknown};
            };
            expect(serialized).not.toContain("test-dashscope-token");
            expect(logged.response.rawMessage).toEqual(JSON.parse(JSON.stringify(result.message).replaceAll("test-dashscope-token", "[REDACTED]")));
            expect(logged.response.rawResponse.reasoningContentLength).toBe(reasoning?.length ?? 0);
            if (reasoning?.trim()) {
                expect(logged.response.rawResponse.reasoning_content).toBe(reasoning.replaceAll("test-dashscope-token", "[REDACTED]"));
            } else {
                expect(logged.response.rawResponse).not.toHaveProperty("reasoning_content");
            }
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
                        reasoning: {content: "DeepSeek private reasoning", scope: "a".repeat(64)},
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

    test("来源固定使用百炼 Key，模型别名不改用其他来源", async () => {
        delete process.env.DASHSCOPE_API_KEY;

        await expect(callQwenProvider(qwenProvider, {
            messages: [{role: "user", origin: "user" as const, content: "hello"}],
            tools: [],
            cwd: process.cwd(),
            model: "qwen3.6-plus",
            kind: "main",
        })).rejects.toThrow("Missing DASHSCOPE_API_KEY");

        const callQwen = createLLMCaller(QWEN_SOURCE);
        await expect(callQwen(
            [{role: "user", origin: "user" as const, content: "hello"}],
            [],
            createTestStorage(process.cwd()),
            process.cwd(),
            "glm-5.2",
            "main"
        )).rejects.toThrow("Missing DASHSCOPE_API_KEY");
    });
});

test("declared-source alias reaches the chosen Qwen endpoint unchanged", async () => {
    await withTempProject(async (cwd, storage) => {
        process.env.DASHSCOPE_API_KEY = "fixture-key";
        let model: unknown;
        let url = "";
        globalThis.fetch = (async (input, init) => {
            url = String(input);
            const body = JSON.parse(String(init?.body)) as {model: unknown};
            model = body.model;
            return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers: {"content-type": "text/event-stream"}});
        }) as typeof fetch;
        const result = await createLLMCaller(QWEN_SOURCE)([{role: "user", origin: "user", content: "hi"}], [], storage, cwd, "vendor/custom-alias", "main");
        expect(result.message.content).toBe("ok");
        expect(model).toBe("vendor/custom-alias");
        expect(url).toBe("https://qwen.test/v1/chat/completions");
    });
});
