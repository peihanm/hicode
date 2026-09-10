import { describe, expect, test } from "bun:test";
import {
  getAutoCompactThreshold,
  getTokenWarningState,
} from "../../src/context/window.js";

describe("context window", () => {
  test("Provider 实报窗口覆盖模型名回退", () => {
    expect(getAutoCompactThreshold("provider-specific-model", 256_000))
      .toBe(223_000);
    const state = getTokenWarningState(237_267, "provider-specific-model", 1_050_000);
    expect(state.percentUsed).toBeCloseTo(237_267 / 480_000, 6);
    expect(state.critical).toBe(false);
  });

  test("GLM-5.2 使用 1M 窗口并预留 summary", () => {
    expect(getAutoCompactThreshold("glm-5.2")).toBe(450_000);
  });

  test("早期 GLM 模型继续按 128K 处理", () => {
    expect(getAutoCompactThreshold("glm-4.7")).toBe(95_000);
  });

  test("Qwen 模型使用各自公开的上下文窗口", () => {
    expect(getAutoCompactThreshold("qwen3.8-flash")).toBe(450_000);
    expect(getAutoCompactThreshold("qwen3.8-max")).toBe(450_000);
    expect(getAutoCompactThreshold("qwen3.8-max-0902")).toBe(450_000);
    expect(getAutoCompactThreshold("qwen3.6-plus")).toBe(450_000);
    expect(getAutoCompactThreshold("qwen3.6-flash")).toBe(450_000);
    expect(getAutoCompactThreshold("qwen3-coder-plus")).toBe(450_000);
    expect(getAutoCompactThreshold("qwen3-coder-next")).toBe(229_144);
  });

  test("DeepSeek 使用 1M 上下文窗口", () => {
    expect(getAutoCompactThreshold("deepseek-pro")).toBe(450_000);
    expect(getAutoCompactThreshold("deepseek-flash")).toBe(450_000);
  });

  test("未知模型使用配置窗口，不因名称未登记回退 128K", () => {
    expect(getAutoCompactThreshold("provider-specific-model")).toBe(450_000);
    expect(getAutoCompactThreshold("provider-specific-model", undefined,
      {windowTokens: 1_000_000, autoCompactTokenLimit: 900_000})).toBe(900_000);
  });

  test("达到阈值时进入 critical", () => {
    const threshold = getAutoCompactThreshold("glm-test");
    const state = getTokenWarningState(threshold, "glm-test");
    expect(state.critical).toBe(true);
  });
});

test("配置可调大到 1M，较小模型或 Provider 窗口仍限制预算", () => {
  const settings = {windowTokens: 1_000_000, autoCompactTokenLimit: 900_000};
  for (const model of ["deepseek-pro", "deepseek-flash", "qwen3.8-flash"]) {
    expect(getAutoCompactThreshold(model, undefined, settings)).toBe(900_000);
    expect(getTokenWarningState(899_999, model, undefined, settings).critical).toBe(false);
    expect(getTokenWarningState(900_000, model, undefined, settings).critical).toBe(true);
  }
  expect(getAutoCompactThreshold("glm-4.7", undefined, settings)).toBe(95_000);
  expect(getAutoCompactThreshold("deepseek-pro", 128_000, settings)).toBe(95_000);
  expect(getAutoCompactThreshold("deepseek-pro", 1_000_000)).toBe(450_000);
});

test("低压缩阈值下，压缩目标也必须低于阈值", async () => {
  const {getCompactTarget} = await import("../../src/context/window.js");
  const settings = {windowTokens: 500_000, autoCompactTokenLimit: 50_000};
  expect(getCompactTarget("deepseek-pro", undefined, settings)).toBeLessThan(50_000);
});
