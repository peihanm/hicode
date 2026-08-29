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
                {messages: [{role: "user", content: "private prompt"}]}
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
                request
            );
            handle.finish({
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 2,
                    total_tokens: 12,
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
});
