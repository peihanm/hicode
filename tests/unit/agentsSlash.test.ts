import {describe, expect, test} from "bun:test";
import {createSlashCommandProcessor} from "../../src/slash/process.js";
import {type AgentDefinition} from "../../src/subagents/index.js";
import {createSubagentRegistry} from "../../src/subagents/registry.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("/agents slash command", () => {
    test("展示 active source、能力、模型和加载问题", async () => {
        await withTempProject(async (cwd) => {
            const reviewer: AgentDefinition = {
                agentType: "reviewer",
                whenToUse: "审查实现风险",
                systemPrompt: "review",
                allowedTools: ["read_file", "bash"],


                source: "project",
                path: `${cwd}/.hicode/agents/reviewer.md`,
            };
            const registry = createSubagentRegistry({
                definitions: [reviewer],
                issues: [{
                    source: "user",
                    path: "/home/.hicode/agents/broken.md",
                    severity: "error",
                    field: "tools",
                    message: "Tool does not exist in this Runtime: missing",
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
            expect(messages[0]).toContain("Agents · 3 available");
            expect(messages[0]).toContain("reviewer · project");
            expect(messages[0]).toContain("Model Same as main agent");
            expect(messages[0]).toContain("Tools (2) read_file · bash");
            expect(messages[0]).toContain("Loading issues · 1");
            expect(messages[0]).toContain("ERROR · user · broken.md · tools");
            expect(messages[0]).not.toMatch(/Ag\n\s*ent/);
            expect(messages[0]).not.toMatch(/\n\s*[、。，；：！？]/);
        });
    });
});
