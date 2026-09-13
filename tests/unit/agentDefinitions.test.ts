import { describe, expect, test } from "bun:test";
import {
  BUILTIN_SUBAGENT_REGISTRY,
} from "../../src/subagents/index.js";
import {createAgentTool} from "../../src/tools/agent/agent.js";

describe("agent definitions", () => {
  test("内置 Agent 各自使用收窄工具集", () => {
    const explore = BUILTIN_SUBAGENT_REGISTRY.get("Explore")!.definition;
    expect(explore.maxIterations).toBeUndefined();
    expect(explore.allowedTools).toEqual([
      "list_files",
      "glob",
      "read_file",
      "grep",
    ]);
    expect(explore.allowedTools).not.toContain("agent");
    expect(explore.allowedTools).not.toContain("bash");
    expect(explore.allowedTools).not.toContain("write_file");
    expect(explore.whenToUse).toContain("Independent read-only investigation");
    expect(explore.whenToUse).toContain("can run alongside other work");
    expect(explore.whenToUse).toContain("immediately blocks Root");
    expect(explore.whenToUse).not.toContain("3 个以上文件");
    expect(explore.model).toBe("fast");

  });

  test("只接受已注册的 Agent 类型", () => {
    expect(BUILTIN_SUBAGENT_REGISTRY.has("Explore")).toBe(true);
    expect(BUILTIN_SUBAGENT_REGISTRY.has("verification")).toBe(false);
    expect(BUILTIN_SUBAGENT_REGISTRY.listDefinitions().map(agent => agent.agentType)).toEqual(["Explore", "Worker"]);
    expect(BUILTIN_SUBAGENT_REGISTRY.has("GeneralPurpose")).toBe(false);
  });

  test("Agent Tool 不按文件数量机械要求委派", () => {
    const description = createAgentTool(BUILTIN_SUBAGENT_REGISTRY).description;

    expect(description).toContain("Keep immediate blocking work local");
    expect(description).toContain("Complexity or many files alone do not justify delegation");
    expect(description).toContain("Keep immediate blocking work local");
    expect(description).not.toContain("3 个以上文件");
    expect(description).not.toContain("必须优先使用 Explore");
  });
});
