import {expect, test} from "bun:test";
import {formatSubagentModel} from "../../src/subagents/index.js";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {usesFastSubagentModel} from "../../src/subagents/model.js";

test("Only the built-in Explore uses fast; all ordinary roles inherit the parent", () => {
    const explore = BUILTIN_SUBAGENT_REGISTRY.get("Explore")!.definition;
    const worker = BUILTIN_SUBAGENT_REGISTRY.get("Worker")!.definition;
    expect(usesFastSubagentModel(explore)).toBe(true);
    expect(usesFastSubagentModel(worker)).toBe(false);
    expect(usesFastSubagentModel({...explore, source: "host", id: "test"})).toBe(false);
    expect(formatSubagentModel(explore, "fast-model")).toBe("Explore model (fast-model)");
    expect(formatSubagentModel(worker)).toBe("Same as main agent");
});
