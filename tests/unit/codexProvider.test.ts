import {describe, expect, test} from "bun:test";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {resolve} from "node:path";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {createCodexAppServerRuntimeFactory} from "../../src/llm/providers/codex/index.js";
import {createCodexProvider} from "../../src/llm/providers/codex/provider.js";
import {createTestStorage, withTempProject} from "../helpers/tempProject.js";

const fixture = resolve("tests/fixtures/fakeCodexAppServer.ts");

describe("Codex model provider", () => {
    test("ephemeral restricted sandbox + high effort 返回标准 Function Call", async () => {
        await withTempProject(async (cwd) => {
            const createRuntime = createCodexAppServerRuntimeFactory({
                spawnProcess: ((_command, _args, options) =>
                    spawn(
                        process.execPath,
                        [fixture],
                        options
                    ) as ChildProcessWithoutNullStreams),
                authFileExists: async () => false,
            });
            const runtime = createRuntime(
                createChildProcessEnvironment(process.env, [])
            );
            const phases: string[] = [];
            try {
                const result = await createCodexProvider(runtime).call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-5.6-sol",
                    kind: "main",
                    messages: [{role: "user", content: "Read README"}],
                    tools: [{
                        type: "function",
                        function: {
                            name: "read_file",
                            description: "read one file",
                            parameters: {
                                type: "object",
                                properties: {path: {type: "string"}},
                                required: ["path"],
                            },
                        },
                    }],
                    onStreamProgress: (progress) => phases.push(progress.phase),
                }, {
                    id: "codex",
                    label: "OpenAI Codex",
                    apiKeyEnv: "CODEX_API_KEY",
                });

                expect(result.message).toEqual({
                    role: "assistant",
                    content: null,
                    tool_calls: [{
                        id: "call-fake",
                        type: "function",
                        function: {
                            name: "read_file",
                            arguments: JSON.stringify({path: "README.md"}),
                        },
                    }],
                });
                expect(result.toolCalls).toEqual([{
                    id: "call-fake",
                    type: "function",
                    function: {
                        name: "read_file",
                        arguments: JSON.stringify({path: "README.md"}),
                    },
                }]);
                expect(result.usage).toEqual({
                    prompt_tokens: 30,
                    completion_tokens: 4,
                    total_tokens: 34,
                });
                expect(phases).toContain("reasoning");
                expect(phases).toContain("content");
            } finally {
                await runtime.close();
            }
        });
    });

    test("Codex 尝试调用自己的工具时 fail closed", async () => {
        await withTempProject(async (cwd) => {
            const createRuntime = createCodexAppServerRuntimeFactory({
                spawnProcess: ((_command, _args, options) =>
                    spawn(
                        process.execPath,
                        [fixture],
                        options
                    ) as ChildProcessWithoutNullStreams),
                authFileExists: async () => false,
            });
            const runtime = createRuntime(
                createChildProcessEnvironment(process.env, [])
            );
            try {
                await expect(runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-forbidden",
                    kind: "main",
                    messages: [{role: "user", content: "run pwd"}],
                    tools: [],
                })).rejects.toThrow("被禁用的内置能力：commandExecution");
            } finally {
                await runtime.close();
            }
        });
    });

    test("隔离权限 Profile 不可用时不启动模型 Turn", async () => {
        await withTempProject(async (cwd) => {
            const createRuntime = createCodexAppServerRuntimeFactory({
                spawnProcess: ((_command, _args, options) =>
                    spawn(
                        process.execPath,
                        [fixture],
                        options
                    ) as ChildProcessWithoutNullStreams),
                authFileExists: async () => false,
            });
            const runtime = createRuntime(createChildProcessEnvironment({
                ...process.env,
                PILLAR_TEST_CODEX_PROFILE: "denied",
            }, []));
            try {
                await expect(runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-5.6-sol",
                    kind: "main",
                    messages: [{role: "user", content: "hello"}],
                    tools: [],
                })).rejects.toThrow("未启用 Pillar 的受限权限 Profile");
            } finally {
                await runtime.close();
            }
        });
    });
});
