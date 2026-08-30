import {describe, expect, test} from "bun:test";
import {join} from "node:path";
import {createSlashCommandProcessor} from "../../src/slash/process.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime} from "../helpers/memory.js";

describe("/memory slash command", () => {
    test("显示状态、读取并精确遗忘主题", async () => {
        await withTempProject(async (cwd) => {
            const directory = join(cwd, "memory");
            const memory = createTestMemoryRuntime(cwd, {directory});
            await memory.upsert({
                key: "user-response-style",
                name: "回答风格",
                description: "用户喜欢简洁回答",
                type: "user",
                source: "explicit",
                content: "直接回答，不重复总结。",
            });
            const processSlashCommand = createSlashCommandProcessor({
                compactHistory: async ({preTokenCount}) => ({
                    compacted: false,
                    preTokenCount,
                    threshold: 1_000,
                }),
                getToolSchemas: () => [],
                subagents: BUILTIN_SUBAGENT_REGISTRY,
                memory,
            });
            const events: string[] = [];
            const context = {
                history: [{role: "system" as const, content: "system"}],
                ctx: createTestContext(cwd),
                onEvent(event: {type: string; content?: string}) {
                    events.push(event.content ?? event.type);
                },
            };

            expect(await processSlashCommand.process("/memory", context)).toBe(true);
            expect(await processSlashCommand.process("/memory show user-response-style", context)).toBe(true);
            expect(await processSlashCommand.process("/memory forget user-response-style", context)).toBe(true);
            expect(events.some((line) => line.includes("Memory: enabled"))).toBe(true);
            expect(events.some((line) => line.includes("直接回答"))).toBe(true);
            expect(events).toContain("memory_update");
            expect(events).toContain("Memory 已忘记: user-response-style");
            expect(await memory.read("user-response-style")).toBeUndefined();
            await memory.close();
        });
    });

    test("超长 Slash 文本结果在进入 UI 前被截断", async () => {
        await withTempProject(async (cwd) => {
            const memory = createTestMemoryRuntime(cwd, {
                directory: join(cwd, "memory"),
            });
            await memory.upsert({
                key: "project-large-note",
                name: "大笔记",
                description: "输出边界",
                type: "project",
                source: "explicit",
                content: "短正文",
            });
            const entry = await memory.read("project-large-note");
            if (!entry) throw new Error("fixture memory missing");
            memory.read = async () => ({
                ...entry,
                content: "x".repeat(120_000),
            });
            const processor = createSlashCommandProcessor({
                compactHistory: async ({preTokenCount}) => ({
                    compacted: false,
                    preTokenCount,
                    threshold: 1_000,
                }),
                getToolSchemas: () => [],
                subagents: BUILTIN_SUBAGENT_REGISTRY,
                memory,
            });
            const output: string[] = [];
            await processor.process("/memory show project-large-note", {
                history: [],
                ctx: createTestContext(cwd),
                onEvent(event) {
                    if (event.type === "assistant_text") output.push(event.content);
                },
            });
            expect(output[0]?.length).toBeLessThan(101_000);
            expect(output[0]).toContain("Slash output truncated");
            await memory.close();
        });
    });
});
