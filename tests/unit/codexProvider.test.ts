import {describe, expect, test} from "bun:test";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {resolve} from "node:path";
import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";
import {createCodexAppServerRuntimeFactory} from "../../src/llm/providers/codex/index.js";
import {createCodexProvider} from "../../src/llm/providers/codex/provider.js";
import type {OpenAITool} from "../../src/llm/types.js";
import {createTestStorage, withTempProject} from "../helpers/tempProject.js";

const fixture = resolve("tests/fixtures/fakeCodexAppServer.ts");
const READ_FILE_TOOL: OpenAITool = {
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
};

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
                    tools: [READ_FILE_TOOL],
                    onStreamProgress: (progress) => phases.push(progress.phase),
                }, {
                    id: "codex",
                    label: "OpenAI Codex",
                    apiKeyEnv: "CODEX_API_KEY",
                });

                expect(result.toolCalls).toHaveLength(1);
                const toolCall = result.toolCalls[0]!;
                expect(toolCall.id).toMatch(/^call_codex_[0-9a-f-]+$/);
                expect(toolCall).toEqual({
                    id: toolCall.id,
                    type: "function",
                    function: {
                        name: "read_file",
                        arguments: JSON.stringify({path: "README.md"}),
                    },
                });
                expect(result.message).toEqual({
                    role: "assistant",
                    content: null,
                    tool_calls: [toolCall],
                });
                expect(result.usage).toEqual({
                    prompt_tokens: 30,
                    completion_tokens: 4,
                    total_tokens: 34,
                });
                expect(result.contextUsage).toEqual({
                    tokenCount: 34,
                    contextWindow: 200_000,
                });
                expect(phases).toContain("reasoning");
                expect(phases).toContain("content");
            } finally {
                await runtime.close();
            }
        });
    });

    test("共享 Runtime 会串行处理并发的 primary 和 fast 调用", async () => {
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
            const call = (kind: "main" | "hook") => runtime.call({
                storage: createTestStorage(cwd),
                cwd,
                model: "gpt-5.6-luna",
                kind,
                messages: [{role: "user", content: kind}],
                tools: [READ_FILE_TOOL],
            });
            try {
                const results = await Promise.all([call("main"), call("hook")]);
                expect(results).toHaveLength(2);
                expect(results.every((result) => result.usage.total_tokens === 34)).toBe(true);
            } finally {
                await runtime.close();
            }
        });
    });

    test("无效 Bridge Function Call 会在新 ephemeral thread 中修复一次", async () => {
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
                PILLAR_TEST_CODEX_BRIDGE_REPAIR: "1",
            }, []));
            const phases: string[] = [];
            try {
                const result = await runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-5.6-luna",
                    kind: "main",
                    messages: [{role: "user", content: "Read README"}],
                    tools: [READ_FILE_TOOL],
                    onStreamProgress: (progress) => phases.push(progress.phase),
                });

                expect(result.toolCalls).toHaveLength(1);
                expect(result.toolCalls[0]!.function.name).toBe("read_file");
                expect(result.toolCalls[0]!.id).toMatch(/^call_codex_[0-9a-f-]+$/);
                expect(result.usage).toEqual({
                    prompt_tokens: 60,
                    completion_tokens: 8,
                    total_tokens: 68,
                });
                expect(result.contextUsage).toEqual({
                    tokenCount: 34,
                    contextWindow: 200_000,
                });
                expect(phases).toContain("retrying");
            } finally {
                await runtime.close();
            }
        });
    });

    test("Bridge 修复只重试一次", async () => {
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
                PILLAR_TEST_CODEX_BRIDGE_REPAIR: "always",
            }, []));
            try {
                await expect(runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-5.6-luna",
                    kind: "main",
                    messages: [{role: "user", content: "Read README"}],
                    tools: [READ_FILE_TOOL],
                })).rejects.toThrow("Codex Bridge 修复重试失败");
            } finally {
                await runtime.close();
            }
        });
    });

    test("Codex 内置工具尝试被中断后以新 ephemeral thread 修复", async () => {
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
                const result = await runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-forbidden-once",
                    kind: "main",
                    messages: [{role: "user", content: "verify index.html"}],
                    tools: [READ_FILE_TOOL],
                    onStreamProgress: (progress) => phases.push(progress.phase),
                });

                expect(result.toolCalls).toHaveLength(1);
                expect(result.toolCalls[0]!.function.name).toBe("read_file");
                expect(result.usage).toEqual({
                    prompt_tokens: 39,
                    completion_tokens: 5,
                    total_tokens: 44,
                });
                expect(result.contextUsage).toEqual({
                    tokenCount: 34,
                    contextWindow: 200_000,
                });
                expect(phases).toContain("retrying");
            } finally {
                await runtime.close();
            }
        });
    });

    test("累计 usage 与当前上下文 usage/window 保持独立", async () => {
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
                PILLAR_TEST_CODEX_DISTINCT_USAGE: "1",
            }, []));
            try {
                const result = await runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-5.6-luna",
                    kind: "main",
                    messages: [{role: "user", content: "Read README"}],
                    tools: [READ_FILE_TOOL],
                });

                expect(result.usage).toEqual({
                    prompt_tokens: 300,
                    completion_tokens: 40,
                    total_tokens: 340,
                });
                expect(result.contextUsage).toEqual({
                    tokenCount: 74,
                    contextWindow: 1_050_000,
                });
            } finally {
                await runtime.close();
            }
        });
    });

    test("Codex 输出停滞会立即中断并在新 ephemeral thread 恢复", async () => {
        await withTempProject(async (cwd) => {
            const createRuntime = createCodexAppServerRuntimeFactory({
                spawnProcess: ((_command, _args, options) =>
                    spawn(
                        process.execPath,
                        [fixture],
                        options
                    ) as ChildProcessWithoutNullStreams),
                authFileExists: async () => false,
                outputStallTimeoutMs: 20,
            });
            const runtime = createRuntime(createChildProcessEnvironment({
                ...process.env,
                PILLAR_TEST_CODEX_OUTPUT_STALL: "once",
            }, []));
            const phases: string[] = [];
            const startedAt = Date.now();
            try {
                const result = await runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-5.6-luna",
                    kind: "main",
                    messages: [{role: "user", content: "Read README"}],
                    tools: [READ_FILE_TOOL],
                    onStreamProgress: (progress) => phases.push(progress.phase),
                });

                expect(Date.now() - startedAt).toBeLessThan(500);
                expect(result.usage).toEqual({
                    prompt_tokens: 39,
                    completion_tokens: 5,
                    total_tokens: 44,
                });
                expect(phases).toContain("stalled");
                expect(phases).toContain("retrying");
            } finally {
                await runtime.close();
            }
        });
    });

    test("Codex 连续输出停滞最多重试两次", async () => {
        await withTempProject(async (cwd) => {
            const createRuntime = createCodexAppServerRuntimeFactory({
                spawnProcess: ((_command, _args, options) =>
                    spawn(
                        process.execPath,
                        [fixture],
                        options
                    ) as ChildProcessWithoutNullStreams),
                authFileExists: async () => false,
                outputStallTimeoutMs: 20,
            });
            const runtime = createRuntime(createChildProcessEnvironment({
                ...process.env,
                PILLAR_TEST_CODEX_OUTPUT_STALL: "always",
            }, []));
            const phases: string[] = [];
            try {
                await expect(runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-5.6-luna",
                    kind: "main",
                    messages: [{role: "user", content: "Read README"}],
                    tools: [READ_FILE_TOOL],
                    onStreamProgress: (progress) => phases.push(progress.phase),
                })).rejects.toThrow(
                    "Codex 输出连续 20ms 没有新增量，安全重试后仍无进展"
                );
                expect(phases.filter((phase) => phase === "retrying"))
                    .toHaveLength(2);
                expect(phases.filter((phase) => phase === "stalled").length)
                    .toBeGreaterThanOrEqual(3);
            } finally {
                await runtime.close();
            }
        });
    });

    test("Codex 持续推理增量会刷新 watchdog 而不限制总生成时间", async () => {
        await withTempProject(async (cwd) => {
            const createRuntime = createCodexAppServerRuntimeFactory({
                spawnProcess: ((_command, _args, options) =>
                    spawn(
                        process.execPath,
                        [fixture],
                        options
                    ) as ChildProcessWithoutNullStreams),
                authFileExists: async () => false,
                outputStallTimeoutMs: 20,
            });
            const runtime = createRuntime(createChildProcessEnvironment({
                ...process.env,
                PILLAR_TEST_CODEX_CONTINUOUS_PROGRESS: "1",
            }, []));
            const phases: string[] = [];
            try {
                const result = await runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-5.6-luna",
                    kind: "main",
                    messages: [{role: "user", content: "keep working"}],
                    tools: [],
                    onStreamProgress: (progress) => phases.push(progress.phase),
                });

                expect(result.message.content).toBe("progress complete");
                expect(phases.filter((phase) => phase === "reasoning").length)
                    .toBeGreaterThanOrEqual(4);
                expect(phases).not.toContain("retrying");
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
            const phases: string[] = [];
            try {
                await expect(runtime.call({
                    storage: createTestStorage(cwd),
                    cwd,
                    model: "gpt-forbidden",
                    kind: "main",
                    messages: [{role: "user", content: "run pwd"}],
                    tools: [],
                    onStreamProgress: (progress) => phases.push(progress.phase),
                })).rejects.toThrow(
                    "修复重试失败：Codex 尝试调用被禁用的内置能力：commandExecution"
                );
                expect(phases.filter((phase) => phase === "retrying")).toHaveLength(1);
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
