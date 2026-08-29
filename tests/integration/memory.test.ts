import {describe, expect, test} from "bun:test";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {
    createAgentRunner,
    EMPTY_AGENT_INPUT_CHANNEL,
} from "../../src/agent/index.js";
import type {AgentEvent} from "../../src/agent/types.js";
import {
    createMemoryAwareAgentRunner,
    serializeMemoryFile,
} from "../../src/memory/index.js";
import {createToolRuntime} from "../../src/tools/registry.js";
import {createInitialHistory} from "../../src/prompt/index.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";

const noCompact = async ({preTokenCount}: {preTokenCount: number}) => ({
    compacted: false as const,
    preTokenCount,
    threshold: 1_000_000,
});

describe("Persistent Memory", () => {
    test("Memory 不再暴露专用 Function Tool，Root 使用标准文件工具", async () => {
        const tools = createToolRuntime();
        expect(tools.toolNames).not.toContain("memory");
        expect(tools.toolNames).toEqual(expect.arrayContaining([
            "read_file",
            "write_file",
            "edit_file",
            "delete_file",
        ]));
    });

    test("Root Agent 按主题文件再索引的两步流程保存 Memory", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, "memory");
            const memory = createTestMemoryRuntime(cwd, {directory});
            const topicPath = join(directory, "feedback-production-api.md");
            const indexPath = join(directory, "MEMORY.md");
            const timestamp = "2026-07-26T00:00:00.000Z";
            const topic = serializeMemoryFile(
                {
                    key: "feedback-production-api",
                    name: "生产 API 边界",
                    description: "测试不能扩张生产 Options",
                    type: "feedback",
                    source: "explicit",
                    content: "测试替身放在组合工厂，普通调用只保留真实参数。",
                },
                {createdAt: timestamp, updatedAt: timestamp}
            );
            const fake = createFakeLLM([
                assistantToolCall("read_file", {path: indexPath}, "read-index"),
                assistantToolCall("write_file", {
                    path: topicPath,
                    content: topic,
                    overwrite_existing: false,
                }, "write-topic"),
                assistantToolCall("edit_file", {
                    path: indexPath,
                    old_string: "# Pillar Memory",
                    new_string:
                        "# Pillar Memory\n\n- [生产 API 边界](feedback-production-api.md) — 测试不能扩张生产 Options",
                    replace_all: false,
                }, "edit-index"),
                assistantToolCall("read_file", {path: topicPath}, "verify-topic"),
                assistantToolCall("read_file", {path: indexPath}, "verify-index"),
                assistantText("已经记住。"),
            ]);
            const root = createMemoryAwareAgentRunner(
                createAgentRunner({callLLM: fake.callLLM, compactHistory: noCompact}),
                memory
            );
            const tools = createToolRuntime();
            const history = createInitialHistory(cwd, "glm-test");
            const events: AgentEvent[] = [];
            const result = await root(
                "请记住：不要为了测试扩张生产接口",
                history,
                (event) => events.push(event),
                createTestContext(cwd, {
                    memoryFiles: memory.fileAccess("explicit"),
                }),
                EMPTY_AGENT_INPUT_CHANNEL,
                {
                    getToolSchemas: tools.getToolSchemas,
                    executeTool: tools.executeTool,
                    isToolConcurrencySafe: tools.isConcurrencySafe,
                }
            );

            expect(result.reason).toBe("completed");
            expect((await memory.read("feedback-production-api"))?.content)
                .toContain("组合工厂");
            expect(events.some((event) =>
                event.type === "memory_update" && event.source === "explicit"
            )).toBe(true);
            expect(history.some((message) =>
                typeof message.content === "string" &&
                message.content.includes("<system-reminder>\n# Persistent memory")
            )).toBe(false);

            const nextFake = createFakeLLM([assistantText("会保持生产 API 诚实。")]);
            const nextRoot = createMemoryAwareAgentRunner(
                createAgentRunner({callLLM: nextFake.callLLM, compactHistory: noCompact}),
                memory
            );
            await nextRoot(
                "接下来这个测试应该怎么设计？",
                createInitialHistory(cwd, "glm-test"),
                () => {},
                createTestContext(cwd, {
                    memoryFiles: memory.fileAccess("explicit"),
                }),
                EMPTY_AGENT_INPUT_CHANNEL,
                {
                    getToolSchemas: () => [],
                    executeTool: async () => "unexpected tool call",
                    isToolConcurrencySafe: () => false,
                }
            );
            const invoke = nextFake.calls[0]?.messages
                .map((message) => typeof message.content === "string" ? message.content : "")
                .join("\n") ?? "";
            expect(invoke).toContain("feedback-production-api.md");
            expect(invoke).not.toContain("测试替身放在组合工厂");
            await memory.close();
        });
    });

    test("高价值反馈在主回答后交给自动 Memory Agent，并在关闭时收尾", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, "memory");
            let extractorCalled = false;
            const memory = createTestMemoryRuntime(cwd, {
                directory,
                autoExtract: true,
                createExtractor: ({memoryFiles}) => ({
                    async extract(input) {
                        extractorCalled = true;
                        expect(input.turns.at(-1)?.user).toContain("以后");
                        const timestamp = "2026-07-26T00:00:00.000Z";
                        await memoryFiles.write(
                            join(directory, "feedback-no-summary.md"),
                            serializeMemoryFile(
                                {
                                    key: "feedback-no-summary",
                                    name: "不要重复总结",
                                    description: "用户不喜欢回答末尾重复总结",
                                    type: "feedback",
                                    source: "automatic",
                                    content: "直接交付结果，不在结尾重复已经说过的内容。",
                                },
                                {createdAt: timestamp, updatedAt: timestamp}
                            ),
                            null
                        );
                    },
                }),
            });
            const fake = createFakeLLM([assistantText("明白。")]);
            const root = createMemoryAwareAgentRunner(
                createAgentRunner({callLLM: fake.callLLM, compactHistory: noCompact}),
                memory
            );
            const events: AgentEvent[] = [];
            const result = await root(
                "以后不要在结尾重复总结",
                createInitialHistory(cwd, "glm-test"),
                (event) => events.push(event),
                createTestContext(cwd, {
                    memoryFiles: memory.fileAccess("explicit"),
                }),
                EMPTY_AGENT_INPUT_CHANNEL,
                {
                    getToolSchemas: () => [],
                    executeTool: async () => "unexpected tool call",
                    isToolConcurrencySafe: () => false,
                }
            );
            expect(result.reply).toBe("明白。");
            await memory.close();
            expect(extractorCalled).toBe(true);
            expect((await memory.read("feedback-no-summary"))?.source)
                .toBe("automatic");
            expect(events.some((event) =>
                event.type === "memory_update" && event.source === "automatic"
            )).toBe(true);
        });
    });

    test("用户要求忽略 Memory 时不读取、不 reconciliation，也不触发自动维护", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, "memory");
            const memory = createTestMemoryRuntime(cwd, {
                directory,
                autoExtract: true,
                createExtractor: () => ({
                    async extract() {
                        throw new Error("ignored turn must not extract");
                    },
                }),
            });
            const fake = createFakeLLM([assistantText("本轮不使用记忆。")]);
            const root = createMemoryAwareAgentRunner(
                createAgentRunner({callLLM: fake.callLLM, compactHistory: noCompact}),
                memory
            );
            await root(
                "这次不要使用任何 Memory",
                createInitialHistory(cwd, "glm-test"),
                () => {},
                createTestContext(cwd, {
                    memoryFiles: memory.fileAccess("explicit"),
                }),
                EMPTY_AGENT_INPUT_CHANNEL,
                {
                    getToolSchemas: () => [],
                    executeTool: async () => "unexpected tool call",
                    isToolConcurrencySafe: () => false,
                }
            );
            await memory.close();
            expect(existsSync(directory)).toBe(false);
        });
    });
});
