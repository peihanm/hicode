import {describe, expect, test} from "bun:test";
import type {CompactHistoryRunner} from "../../src/agent/invokePreparation.js";
import {createSlashCommandProcessor} from "../../src/slash/process.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";

describe("/compact runtime binding", () => {
    test("使用宿主注入的 Compact runner，而不是模块默认 Provider", async () => {
        await withTempProject(async (cwd) => {
            let received: Parameters<CompactHistoryRunner>[0] | undefined;
            const configuredCompact: CompactHistoryRunner = async (input) => {
                received = input;
                return {
                    compacted: false,
                    preTokenCount: input.preTokenCount,
                    threshold: 100,
                    message: "fixture stopped",
                };
            };
            const processSlashCommand = createSlashCommandProcessor({
                compactHistory: configuredCompact,
                getToolSchemas: () => [{
                    type: "function",
                    function: {
                        name: "dynamic_tool",
                        description: "session dynamic tool",
                        parameters: {type: "object"},
                    },
                }],
                subagents: BUILTIN_SUBAGENT_REGISTRY,
            });
            const events: string[] = [];

            const handled = await processSlashCommand.process(
                "/compact 保留配置结论",
                {
                    history: [
                        {role: "system", content: "system"},
                        {role: "user", origin: "user" as const, content: "hello"},
                        {role: "assistant", content: "world"},
                    ],
                    ctx: createTestContext(cwd),
                    onEvent(event) {
                        events.push(event.type);
                    },
                }
            );

            expect(handled).toBe(true);
            expect(received).toMatchObject({
                force: true,
                trigger: "manual",
                customInstructions: "保留配置结论",
            });
            expect(received?.tools.map((tool) => tool.function.name))
                .toEqual(["dynamic_tool"]);
            expect(events).toEqual(["compact_start", "compact_error"]);
        });
    });
});

import type {AgentEvent} from "../../src/agent/types.js";

test("手动 compact 传递同一配置和 Provider 窗口，成功后更新百分比", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd, {model: "deepseek-pro", provider: "deepseek",
            contextSettings: {windowTokens: 1_000_000, autoCompactTokenLimit: 800_000}});
        ctx.contextUsage.record({model: ctx.model, provider: ctx.provider, compactCount: 0}, [], [], 10, 900_000);
        const events: AgentEvent[] = [];
        const processor = createSlashCommandProcessor({getToolSchemas: () => [], subagents: BUILTIN_SUBAGENT_REGISTRY,
            compactHistory: async input => {
                expect(input.contextWindow).toBe(900_000);
                expect(input.ctx.contextSettings).toBe(ctx.contextSettings);
                input.history.splice(1, input.history.length - 1, {role: "user", origin: "compaction", content: "summary"});
                return {compacted: true, preTokenCount: input.preTokenCount, threshold: 800_000};
            }});
        await processor.process("/compact", {ctx, history: [{role: "system", content: "system"}, {role: "user", origin: "user", content: "task"}],
            onEvent: event => {events.push(event);}});
        expect(events[0]).toMatchObject({type: "compact_start", threshold: 800_000});
        const update = events.find(event => event.type === "token_update");
        expect(update?.percentUsed).toBeCloseTo(update!.tokenCount / 880_000, 8);
    });
});
