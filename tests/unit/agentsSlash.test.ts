import {describe, expect, test} from "bun:test";
import {createSlashCommandProcessor} from "../../src/slash/process.js";
import {
    createSubagentRegistry,
    type AgentDefinition,
} from "../../src/subagents/index.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("/agents slash command", () => {
    test("展示 active source、能力、模型和加载问题", async () => {
        await withTempProject(async (cwd) => {
            const reviewer: AgentDefinition = {
                agentType: "reviewer",
                whenToUse: "审查实现风险",
                systemPrompt: "review",
                allowedTools: ["read_file", "grep"],
                model: "fast",
                maxIterations: 7,
                source: "project",
                path: `${cwd}/.pillar/agents/reviewer.md`,
            };
            const registry = createSubagentRegistry({
                definitions: [reviewer],
                issues: [{
                    source: "user",
                    path: "/home/.pillar/agents/broken.md",
                    severity: "error",
                    field: "tools",
                    message: "当前 Runtime 不存在工具: missing",
                }],
            });
            const processSlashCommand = createSlashCommandProcessor({
                compactHistory: async () => ({
                    compacted: false,
                    preTokenCount: 0,
                    threshold: 0,
                }),
                getToolSchemas: () => [],
                subagents: registry,
            });
            const messages: string[] = [];

            const handled = await processSlashCommand.process("/agents", {
                history: [],
                ctx: createTestContext(cwd),
                onEvent(event) {
                    if (event.type === "assistant_text") {
                        messages.push(event.content);
                    }
                },
            });

            expect(handled).toBe(true);
            expect(messages).toHaveLength(1);
            expect(messages[0]).toContain("Agents · 4 个可用");
            expect(messages[0]).toContain("reviewer · project");
            expect(messages[0]).toContain("模型 fast (glm-fast-test) · 最大轮次 7");
            expect(messages[0]).toContain("工具 (2) read_file · grep");
            expect(messages[0]).toContain("加载问题 · 1");
            expect(messages[0]).toContain("ERROR · user · broken.md · tools");
            expect(messages[0]).not.toMatch(/Ag\n\s*ent/);
            expect(messages[0]).not.toMatch(/\n\s*[、。，；：！？]/);
        });
    });
});
