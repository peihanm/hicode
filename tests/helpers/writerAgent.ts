import {createSubagentRegistry} from "../../src/subagents/registry.js";
export function createWriterRegistry() {
    return createSubagentRegistry({issues: [], definitions: [{
        agentType: "FixtureWriter", source: "host", id: "fixture-writer",
        whenToUse: "Test a bounded custom implementation", systemPrompt: "Implement the assigned file change.",

        allowedTools: ["read_file", "bash", "write_file", "edit_file"],
    }]});
}
