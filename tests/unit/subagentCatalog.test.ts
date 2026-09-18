import {describe, expect, test} from "bun:test";
import {
    createSubagentCatalog,
    type AgentDefinition,
    type LoadedCustomAgents,
} from "../../src/subagents/index.js";
import {createAgentTool} from "../../src/tools/agent/agent.js";
import {createToolRuntime} from "../../src/tools/registry.js";

function definition(name: string, description = `use ${name}`): AgentDefinition {
    return {
        agentType: name,
        whenToUse: description,
        systemPrompt: `you are ${name}`,
        allowedTools: ["read_file"],


        source: "project",
        path: `/tmp/${name}.md`,
    };
}

describe("subagent catalog", () => {
    test("原子替换 snapshot，并让下一次 Tool Schema 读取到新 revision", async () => {
        let loaded: LoadedCustomAgents = {
            definitions: [definition("reviewer")],
            issues: [],
        };
        const catalog = createSubagentCatalog({
            initial: loaded,
            load: async () => loaded,
        });
        const runtime = createToolRuntime({
            toolOverrides: [createAgentTool(catalog)],
        });
        const before = catalog.get("reviewer");
        expect(catalog.revision).toBe(1);
        expect(runtime.getToolSchemas().find((tool) =>
            tool.function.name === "agent"
        )?.function.description).toContain("reviewer");

        loaded = {
            definitions: [definition("architect")],
            issues: [],
        };
        const update = await catalog.reload();
        expect(update).toMatchObject({
            revision: 2,
            added: ["architect"],
            removed: ["reviewer"],
        });
        expect(before?.definition.agentType).toBe("reviewer");
        expect(catalog.has("reviewer")).toBe(false);
        expect(catalog.has("architect")).toBe(true);
        const description = runtime.getToolSchemas().find((tool) =>
            tool.function.name === "agent"
        )?.function.description;
        expect(description).toContain("architect");
        expect(description).not.toContain("reviewer");
    });

    test("reload 抛错时保留最后可用 snapshot 和 revision", async () => {
        const catalog = createSubagentCatalog({
            initial: {definitions: [definition("stable")], issues: []},
            load: async () => {
                throw new Error("broken directory");
            },
        });
        const registration = catalog.get("stable");
        const update = await catalog.reload();
        expect(update.revision).toBe(1);
        expect(catalog.get("stable")).toBe(registration);
        expect(catalog.has("stable")).toBe(true);
        expect(catalog.issues.at(-1)?.message).toContain("broken directory");
    });

    test("新 Registry 构建失败时同样保留旧 snapshot", async () => {
        const catalog = createSubagentCatalog({
            initial: {definitions: [definition("stable")], issues: []},
            load: async () => ({
                definitions: [{...definition("invalid"), allowedTools: []}],
                issues: [],
            }),
        });
        const registration = catalog.get("stable");
        const update = await catalog.reload();
        expect(update.revision).toBe(1);
        expect(catalog.get("stable")).toBe(registration);
        expect(catalog.has("stable")).toBe(true);
        expect(catalog.has("invalid")).toBe(false);
    });
});
