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
    expect(explore.whenToUse).toContain("可独立完成");
    expect(explore.whenToUse).toContain("可并发推进");
    expect(explore.whenToUse).toContain("Root 必须等待结果才能继续");
    expect(explore.whenToUse).not.toContain("3 个以上文件");
    expect(explore.model).toBe("fast");

  });

  test("只接受已注册的 Agent 类型", () => {
    expect(BUILTIN_SUBAGENT_REGISTRY.has("Explore")).toBe(true);
    expect(BUILTIN_SUBAGENT_REGISTRY.has("verification")).toBe(false);
    expect(BUILTIN_SUBAGENT_REGISTRY.listDefinitions().map(agent => agent.agentType)).toEqual(["Explore"]);
    expect(BUILTIN_SUBAGENT_REGISTRY.has("GeneralPurpose")).toBe(false);
  });

  test("Agent Tool 不按文件数量机械要求委派", () => {
    const description = createAgentTool(BUILTIN_SUBAGENT_REGISTRY).description;

    expect(description).toContain("Root 默认亲自完成顺序性的调查、实现和验证");
    expect(description).toContain("本身都不是委派理由");
    expect(description).toContain("若 Root 必须等待结果才能继续");
    expect(description).not.toContain("3 个以上文件");
    expect(description).not.toContain("必须优先使用 Explore");
  });
});
