import { describe, expect, test } from "bun:test";
import {
  parseVerificationSummary,
} from "../../src/subagents/builtins/verification/index.js";
import {parseVerificationVerdict} from "../../src/subagents/builtins/verification/report.js";

describe("verification agent protocol", () => {
  test("只接受独立 verdict 行并取最后一次结论", () => {
    expect(parseVerificationVerdict("结果通过\nVERDICT: PASS")).toBe("PASS");
    expect(
      parseVerificationVerdict(
        "VERDICT: FAIL\n修正判断\nVERDICT: PARTIAL"
      )
    ).toBe("PARTIAL");
    expect(parseVerificationVerdict("**VERDICT: PASS**")).toBeUndefined();
    expect(parseVerificationVerdict("verdict: pass")).toBeUndefined();
  });

  test("优先读取 SUMMARY，并兼容旧报告的关键章节", () => {
    expect(
      parseVerificationSummary(
        "SUMMARY: API 已通过；浏览器交互未验证\nVERDICT: PARTIAL",
        "PARTIAL"
      )
    ).toBe("API 已通过；浏览器交互未验证");
    expect(
      parseVerificationSummary(
        "### 关键缺陷（FAIL 依据）\n\n`loadProblems()` 把数组当作 DOM 元素。\n\nVERDICT: FAIL",
        "FAIL"
      )
    ).toBe("`loadProblems()` 把数组当作 DOM 元素。");
    expect(
      parseVerificationSummary(
        "### 未验证\n- ❌ 浏览器内实际渲染和点击运行\n\nVERDICT: PARTIAL",
        "PARTIAL"
      )
    ).toBe("浏览器内实际渲染和点击运行");
  });

});
