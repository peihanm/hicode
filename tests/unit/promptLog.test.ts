import {describe, expect, test} from "bun:test";
import {readdir, readFile} from "node:fs/promises";
import {join} from "node:path";
import {beginPromptLog} from "../../src/llm/promptLog.js";
import {withTempProject} from "../helpers/tempProject.js";
import {getProjectDebugDirectory} from "../../src/persistence/index.js";

describe("prompt log lifecycle", () => {
    test("请求开始写入 pending，结束后原位写入最终结果", async () => {
        await withTempProject(async (cwd, storage) => {
            const handle = beginPromptLog(
                storage,
                cwd,
                "main",
                "glm-5.2",
                {messages: [{role: "user", content: "private prompt"}]},
                []
            );
            const directory = join(
                getProjectDebugDirectory(storage, cwd),
                "prompt-logs"
            );
            const [filename] = await readdir(directory);
            const pending = JSON.parse(
                await readFile(join(directory, filename!), "utf8")
            ) as {response: unknown};
            expect(pending.response).toEqual({status: "pending"});

            handle.finish({error: "stalled"});
            const finished = JSON.parse(
                await readFile(join(directory, filename!), "utf8")
            ) as {response: unknown};
            expect(finished.response).toEqual({error: "stalled"});
        });
    });

    test("保留完整消息和调用参数，只压缩重复工具 schema", async () => {
        await withTempProject(async (cwd, storage) => {
            const request = {
                model: "glm-5.2",
                stream: true,
                messages: [
                    {role: "system", content: "完整系统提示"},
                    {role: "user", content: "完整用户任务"},
                    {
                        role: "assistant",
                        content: "准备读取",
                        tool_calls: [{
                            id: "call-1",
                            type: "function",
                            function: {
                                name: "read_file",
                                arguments: "{\"path\":\"/private/source.ts\"}",
                            },
                        }],
                    },
                    {
                        role: "tool",
                        content: "工具返回正文",
                        tool_call_id: "call-1",
                    },
                ],
                tools: [{
                    type: "function",
                    function: {
                        name: "read_file",
                        description: "重复的长描述",
                        parameters: {type: "object", properties: {path: {type: "string"}}},
                    },
                }],
            };
            const handle = beginPromptLog(
                storage,
                cwd,
                "main",
                "glm-5.2",
                request,
                []
            );
            handle.finish({
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 2,
                    total_tokens: 12,
                },
                contextUsage: {
                    tokenCount: 7,
                    contextWindow: 1_050_000,
                },
                rawMessage: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{
                        id: "call-2",
                        type: "function",
                        function: {
                            name: "write_file",
                            arguments: "{\"content\":\"secret\"}",
                        },
                    }],
                },
                rawResponse: {stream: true, provider: "fixture"},
            });

            const directory = join(
                getProjectDebugDirectory(storage, cwd),
                "prompt-logs"
            );
            const [filename] = await readdir(directory);
            const content = await readFile(join(directory, filename!), "utf8");
            const logged = JSON.parse(content) as {
                request: Record<string, unknown>;
                response: Record<string, unknown>;
            };
            expect(logged.request.messages).toEqual([
                {role: "system", content: "完整系统提示"},
                {role: "user", content: "完整用户任务"},
                {
                    role: "assistant",
                    content: "准备读取",
                    tool_calls: [{
                        id: "call-1",
                        type: "function",
                        function: {
                            name: "read_file",
                            arguments: "{\"path\":\"/private/source.ts\"}",
                        },
                    }],
                },
                {
                    role: "tool",
                    content: "工具返回正文",
                    tool_call_id: "call-1",
                },
            ]);
            expect(logged.request.toolNames).toEqual(["read_file"]);
            expect(logged.request.tools).toBeUndefined();
            expect(logged.response.contextUsage).toEqual({
                tokenCount: 7,
                contextWindow: 1_050_000,
            });
            expect(content).toContain("/private/source.ts");
            expect(content).not.toContain("重复的长描述");
            expect(content).toContain("secret");
            expect(request.messages[2]).toMatchObject({
                tool_calls: [{
                    function: {arguments: "{\"path\":\"/private/source.ts\"}"},
                }],
            });
        });
    });

    test("单独保留有界 tool_search 描述用于诊断 Deferred Catalog", async () => {
        await withTempProject(async (cwd, storage) => {
            const manifest = [
                "Registered deferred tools (exact names):",
                "- mega_catalog (2 tools)",
                "  mcp__mega__browser, mcp__mega__github",
            ].join("\n");
            const handle = beginPromptLog(
                storage,
                cwd,
                "main",
                "qwen3.8-flash",
                {
                    messages: [{role: "user", content: "查找浏览器工具"}],
                    tools: [
                        {
                            type: "function",
                            function: {
                                name: "read_file",
                                description: "普通工具说明不应进入日志",
                                parameters: {type: "object"},
                            },
                        },
                        {
                            type: "function",
                            function: {
                                name: "tool_search",
                                description: manifest,
                                parameters: {type: "object"},
                            },
                        },
                    ],
                },
                []
            );
            handle.finish({error: "fixture complete"});

            const directory = join(
                getProjectDebugDirectory(storage, cwd),
                "prompt-logs"
            );
            const [filename] = await readdir(directory);
            const content = await readFile(join(directory, filename!), "utf8");
            const logged = JSON.parse(content) as {
                request: Record<string, unknown>;
            };
            expect(logged.request.toolNames).toEqual([
                "read_file",
                "tool_search",
            ]);
            expect(logged.request.toolSearchDescription).toBe(manifest);
            expect(content).not.toContain("普通工具说明不应进入日志");
            expect(logged.request.tools).toBeUndefined();
        });
    });

    test("日志保留调试参数但遮蔽 Provider API key", async () => {
        await withTempProject(async (cwd, storage) => {
            const apiKey = "provider-key-must-not-leak";
            const handle = beginPromptLog(
                storage,
                cwd,
                "main",
                "glm-5.2",
                {
                    messages: [{
                        role: "user",
                        content: `debug payload key=${apiKey}`,
                    }],
                },
                [apiKey]
            );
            handle.finish({error: `upstream echoed ${apiKey}`});

            const directory = join(
                getProjectDebugDirectory(storage, cwd),
                "prompt-logs"
            );
            const [filename] = await readdir(directory);
            const content = await readFile(join(directory, filename!), "utf8");
            expect(content).not.toContain(apiKey);
            expect(content).toContain("[REDACTED]");
            expect(content).toContain("debug payload key=");
        });
    });

    test("项目 Prompt Log 最多保留最近 200 个文件", async () => {
        await withTempProject(async (cwd, storage) => {
            for (let index = 0; index < 205; index += 1) {
                beginPromptLog(
                    storage,
                    cwd,
                    "main",
                    "glm-5.2",
                    {messages: [{role: "user", content: String(index)}]},
                    []
                );
            }

            const directory = join(
                getProjectDebugDirectory(storage, cwd),
                "prompt-logs"
            );
            expect(await readdir(directory)).toHaveLength(200);
        });
    });
});
