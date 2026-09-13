import {listPromptLogs} from "../helpers/promptLogs.js";
import {afterEach, describe, expect, test} from "bun:test";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {getProjectDebugDirectory} from "../../src/persistence/index.js";
import {createLLMCaller} from "../../src/llm/index.js";
import {deepseekProvider} from "../../src/llm/providers/deepseek.js";
import {createTestStorage, withTempProject} from "../helpers/tempProject.js";
import type {LLMCallOptions, LLMProvider} from "../../src/llm/types.js";

const DEEPSEEK_SOURCE = {
    id: "deepseek" as const,
    label: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrl: "https://deepseek.test/v1/",
};

function callDeepSeek(
    provider: LLMProvider,
    options: Omit<LLMCallOptions, "storage">
) {
    return provider.call({
        ...options,
        storage: createTestStorage(options.cwd),
    }, DEEPSEEK_SOURCE);
}

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.DEEPSEEK_API_KEY;

function restore(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    restore("DEEPSEEK_API_KEY", originalApiKey);
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

            const first = await callDeepSeek(deepseekProvider, {
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
                model: "deepseek-pro",
                kind: "main",
            });

            expect(requests[0]).toMatchObject({
                model: "deepseek-pro",
                stream: true,
                thinking: {type: "enabled"},
                stream_options: {include_usage: true},
            });
            expect(requests[0]).not.toHaveProperty("reasoning_effort");
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

            const second = await callDeepSeek(deepseekProvider, {
                messages: [
                    {role: "user", origin: "user" as const, content: "读取入口"},
                    first.message,
                    {
                        role: "tool",
                        tool_call_id: "call-deepseek-1",
                        content: "file content",
                    },
                ],
                tools: [],
                cwd,
                model: "deepseek-pro",
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
            const directory = join(getProjectDebugDirectory(createTestStorage(cwd), cwd), "requests");
            const logs = await Promise.all((await listPromptLogs(directory)).map(async filename =>
                JSON.parse(await readFile(join(directory, filename), "utf8")) as {
                    response: {
                        rawResponse: {toolCallCount: number; reasoning_content?: string};
                        rawMessage: {reasoning_content?: string};
                    };
                }));
            expect(logs).toHaveLength(2);
            const toolLog = logs.find(log => log.response.rawResponse.toolCallCount === 1);
            const textLog = logs.find(log => log.response.rawResponse.toolCallCount === 0);
            expect(toolLog?.response.rawResponse.reasoning_content).toBe("需要先读取文件");
            expect(toolLog?.response.rawMessage.reasoning_content).toBe("需要先读取文件");
            expect(textLog?.response.rawResponse.reasoning_content).toBe("已经获得文件内容");
            expect(textLog?.response.rawMessage).not.toHaveProperty("reasoning_content");
        });
    });

    test("来源固定使用 DeepSeek Key，模型别名不改用其他来源", async () => {
        delete process.env.DEEPSEEK_API_KEY;

        await expect(callDeepSeek(deepseekProvider, {
            messages: [{role: "user", origin: "user" as const, content: "hello"}],
            tools: [],
            cwd: process.cwd(),
            model: "deepseek-pro",
            kind: "main",
        })).rejects.toThrow("Missing DEEPSEEK_API_KEY");

        await expect(createLLMCaller(DEEPSEEK_SOURCE)(
            [{role: "user", origin: "user" as const, content: "hello"}],
            [],
            createTestStorage(process.cwd()),
            process.cwd(),
            "qwen3.6-plus",
            "main"
        )).rejects.toThrow(
            "Missing DEEPSEEK_API_KEY"
        );
    });

});
