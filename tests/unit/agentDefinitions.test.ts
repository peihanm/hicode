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
      "lsp",
      "read_tool_result",
    ]);
    expect(explore.allowedTools).not.toContain("agent");
    expect(explore.allowedTools).not.toContain("bash");
    expect(explore.allowedTools).not.toContain("write_file");
    expect(explore.whenToUse).toContain("可独立完成");
    expect(explore.whenToUse).toContain("可并发推进");
    expect(explore.whenToUse).toContain("Root 必须等待结果才能继续");
    expect(explore.whenToUse).not.toContain("3 个以上文件");
    expect(explore.model).toBe("fast");

    const general = BUILTIN_SUBAGENT_REGISTRY.get("GeneralPurpose")!.definition;
    expect(general.allowedTools).toEqual([
      "list_files",
      "glob",
      "read_file",
      "grep",
      "lsp",
      "edit_file",
      "write_file",
      "delete_file",
      "read_tool_result",
    ]);
    expect(general.allowedTools).not.toContain("bash");
    expect(general.allowedTools).not.toContain("agent");
    expect(general.allowedTools).not.toContain("task");
    expect(general.whenToUse).toContain("默认不自动使用");
    expect(general.whenToUse).toContain("用户明确要求委派");
    expect(general.whenToUse).toContain("前台串行 Agent");
    expect(general.whenToUse).toContain("不用于承接整个已批准计划");
    expect(general.model).toBe("inherit");

    const verification = BUILTIN_SUBAGENT_REGISTRY.get("Verification")!.definition;
    expect(verification.maxIterations).toBe(8);
    expect(verification.allowedTools).toContain("bash");
    expect(verification.allowedTools).toContain("bash_task");
    expect(verification.allowedTools).not.toContain("agent");
    expect(verification.allowedTools).not.toContain("edit_file");
    expect(verification.allowedTools).not.toContain("write_file");
    expect(verification.systemPrompt).toContain("最多允许两次 curl 请求");
    expect(verification.systemPrompt).toContain("不得用 curl 发送业务数据");
    expect(verification.model).toBe("inherit");
  });

  test("只接受已注册的 Agent 类型", () => {
    expect(BUILTIN_SUBAGENT_REGISTRY.has("Explore")).toBe(true);
    expect(BUILTIN_SUBAGENT_REGISTRY.has("verification")).toBe(true);
    expect(BUILTIN_SUBAGENT_REGISTRY.has("GeneralPurpose")).toBe(true);
  });

  test("Agent Tool 不按文件数量机械要求委派", () => {
    const description = createAgentTool(BUILTIN_SUBAGENT_REGISTRY).description;

    expect(description).toContain("Root 默认亲自完成顺序性的调查、实现和验证");
    expect(description).toContain("本身都不是委派理由");
    expect(description).toContain("若 Root 必须等待结果才能继续");
    expect(description).toContain("GeneralPurpose 默认不自动使用");
    expect(description).toContain("它是前台串行 Agent");
    expect(description).toContain("不用于承接整个已批准计划");
    expect(description).not.toContain("3 个以上文件");
    expect(description).not.toContain("必须优先使用 Explore");
  });
});
