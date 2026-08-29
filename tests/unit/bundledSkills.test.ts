import { describe, expect, test } from "bun:test";
import { loadBundledSkills } from "../../src/skills/bundled.js";

describe("bundled skills", () => {
  test("默认只加载 debug，不向主 Agent 注入 verify", () => {
    expect(loadBundledSkills().map((skill) => skill.name)).toEqual(["debug"]);
  });

  test("debug 保持稳定 metadata 和最小修复约束", () => {
    const debug = loadBundledSkills()[0];

    expect({
      name: debug?.name,
      description: debug?.description,
      whenToUse: debug?.whenToUse,
      source: debug?.source,
      minimalFix: debug?.content.includes("改最小代码，不要顺手重构"),
    }).toEqual({
      name: "debug",
      description: "系统化调试流程",
      whenToUse: "遇到 bug 或测试失败时",
      source: "bundled",
      minimalFix: true,
    });
  });
});
