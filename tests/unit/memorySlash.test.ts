import {describe, expect, test} from "bun:test";
import {createSlashCommandProcessor} from "../../src/slash/process.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestMemoryRuntime, remember} from "../helpers/memory.js";

describe("/memory slash command", () => {
    test("invalid arguments do not read Memory or start maintenance", async () => {
        await withTempProject(async cwd => {
            const memory = createTestMemoryRuntime(cwd);
            memory.status = async () => {throw new Error("Unexpected status read");};
            memory.list = async () => {throw new Error("Unexpected list read");};
            memory.read = async () => {throw new Error("Unexpected topic read");};
            const ctx = createTestContext(cwd);
            Object.defineProperty(ctx, "tasks", {get() {throw new Error("Unexpected maintenance access");}});
            const processor = createSlashCommandProcessor({
                compactHistory: async ({preTokenCount}) => ({compacted: false, preTokenCount, threshold: 1000}),
                getToolSchemas: () => [], subagents: BUILTIN_SUBAGENT_REGISTRY, memory,
            });
            try {
                for (const args of ["status extra", "maintain extra", "list user extra", "show key extra", "show"]) {
                    const output: string[] = [];
                    expect(await processor.process(`/memory ${args}`, {
                        history: [], ctx,
                        onEvent(event) {if (event.type === "assistant_text") output.push(event.content);},
                    })).toBe(true);
                    expect(output).toHaveLength(1);
                    expect(output[0]).toStartWith("Usage: /memory");
                }
            } finally {await memory.close();}
        });
    });

    test("显示状态和读取文件；删除不再提供专用 Slash", async () => {
        await withTempProject(async (cwd) => {
            const memory = createTestMemoryRuntime(cwd);
            await remember(memory, "user-response-style", "直接回答，不重复总结。");
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
            expect(events).not.toContain("memory_update");
            expect(events.some(line => line.includes("Usage: /memory"))).toBe(true);
            expect(await memory.read("user-response-style")).toBeDefined();
            await memory.close();
        });
    });

    test("超长 Slash 文本结果在进入 UI 前被截断", async () => {
        await withTempProject(async (cwd) => {
            const memory = createTestMemoryRuntime(cwd);
            await remember(memory, "project-large-note", "短正文");
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
