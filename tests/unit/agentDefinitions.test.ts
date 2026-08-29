import { describe, expect, test } from "bun:test";
import {
  BUILTIN_SUBAGENT_REGISTRY,
} from "../../src/subagents/index.js";

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
    expect(explore.whenToUse).toContain("主动用于开放式代码库问题");
    expect(explore.whenToUse).toContain("深入理解 src");
    expect(explore.whenToUse).toContain("2–3 个文件");
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
});
