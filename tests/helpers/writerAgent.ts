import {createSubagentRegistry} from "../../src/subagents/registry.js";
export function createWriterRegistry() {
    return createSubagentRegistry({issues: [], definitions: [{
        agentType: "FixtureWriter", source: "host", id: "fixture-writer",
        whenToUse: "Test a bounded custom implementation", systemPrompt: "Implement the assigned file change.",
        model: "inherit", maxIterations: 12,
        allowedTools: ["list_files", "glob", "read_file", "grep", "write_file", "edit_file", "delete_file"],
    }]});
}
