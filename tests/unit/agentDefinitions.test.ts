import { describe, expect, test } from "bun:test";
import {BUILTIN_SUBAGENT_REGISTRY} from "../../src/subagents/registry.js";
import {createAgentTool} from "../../src/tools/agent/tools.js";

describe("agent definitions", () => {
  test("Worker 是唯一内置角色，调查通过 read_only 收窄", () => {
    const worker = BUILTIN_SUBAGENT_REGISTRY.get("Worker")!.definition;
    expect(worker.allowedTools).toBeUndefined();
    expect(worker).not.toHaveProperty("maxIterations");
    expect(worker.whenToUse).toContain("investigation");
  });

  test("只接受已注册的 Agent 类型", () => {
    expect(BUILTIN_SUBAGENT_REGISTRY.has("Explore")).toBe(false);
    expect(BUILTIN_SUBAGENT_REGISTRY.has("verification")).toBe(false);
    expect(BUILTIN_SUBAGENT_REGISTRY.listDefinitions().map(agent => agent.agentType)).toEqual(["Worker"]);
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
