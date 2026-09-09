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
