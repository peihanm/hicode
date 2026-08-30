import { describe, expect, test } from "bun:test";
import {
  getAutoCompactThreshold,
  getTokenWarningState,
} from "../../src/context/window.js";

describe("context window", () => {
  test("GLM-5.2 使用 1M 窗口并预留 summary", () => {
    expect(getAutoCompactThreshold("glm-5.2")).toBe(967_000);
  });

  test("早期 GLM 模型继续按 128K 处理", () => {
    expect(getAutoCompactThreshold("glm-4.7")).toBe(95_000);
  });

  test("Qwen 模型使用各自公开的上下文窗口", () => {
    expect(getAutoCompactThreshold("qwen3.6-plus")).toBe(967_000);
    expect(getAutoCompactThreshold("qwen3.6-flash")).toBe(967_000);
    expect(getAutoCompactThreshold("qwen3-coder-plus")).toBe(967_000);
    expect(getAutoCompactThreshold("qwen3-coder-next")).toBe(229_144);
  });

  test("DeepSeek V4 使用 1M 上下文窗口", () => {
    expect(getAutoCompactThreshold("deepseek-v4-pro")).toBe(967_000);
    expect(getAutoCompactThreshold("deepseek-v4-flash")).toBe(967_000);
  });

  test("中转站未知模型保守回退到 128K", () => {
    expect(getAutoCompactThreshold("provider-specific-model")).toBe(95_000);
  });

  test("达到阈值时进入 critical", () => {
    const threshold = getAutoCompactThreshold("glm-test");
    const state = getTokenWarningState(threshold, "glm-test");
    expect(state.critical).toBe(true);
  });
});
