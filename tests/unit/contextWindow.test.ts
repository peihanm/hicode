import { afterEach, describe, expect, test } from "bun:test";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  RESERVED_FOR_SUMMARY,
  getAutoCompactThreshold,
  getContextWindowForModel,
  getEffectiveContextWindow,
  getTokenWarningState,
} from "../../src/context/window.js";

const originalContextWindow = process.env.CONTEXT_WINDOW;
const originalAutoCompactThreshold = process.env.AUTO_COMPACT_THRESHOLD;

afterEach(() => {
  if (originalContextWindow === undefined) delete process.env.CONTEXT_WINDOW;
  else process.env.CONTEXT_WINDOW = originalContextWindow;
  if (originalAutoCompactThreshold === undefined) {
    delete process.env.AUTO_COMPACT_THRESHOLD;
  } else {
    process.env.AUTO_COMPACT_THRESHOLD = originalAutoCompactThreshold;
  }
});
describe("context window", () => {
  test("GLM-5.2 使用 1M 窗口并预留 summary", () => {
    delete process.env.CONTEXT_WINDOW;
    delete process.env.AUTO_COMPACT_THRESHOLD;
    expect(getContextWindowForModel("glm-5.2")).toBe(1_000_000);
    expect(getEffectiveContextWindow("glm-5.2")).toBe(
      1_000_000 - RESERVED_FOR_SUMMARY
    );
    expect(getAutoCompactThreshold("glm-5.2")).toBe(
      1_000_000 - RESERVED_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS
    );
  });

  test("早期 GLM 模型继续按 128K 处理", () => {
    delete process.env.CONTEXT_WINDOW;
    delete process.env.AUTO_COMPACT_THRESHOLD;
    expect(getContextWindowForModel("glm-4.7")).toBe(128_000);
    expect(getEffectiveContextWindow("glm-4.7")).toBe(
      128_000 - RESERVED_FOR_SUMMARY
    );
    expect(getAutoCompactThreshold("glm-4.7")).toBe(
      128_000 - RESERVED_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS
    );
  });

  test("Qwen 模型使用各自公开的上下文窗口", () => {
    delete process.env.CONTEXT_WINDOW;
    expect(getContextWindowForModel("qwen3.6-plus")).toBe(1_000_000);
    expect(getContextWindowForModel("qwen3.6-flash")).toBe(1_000_000);
    expect(getContextWindowForModel("qwen3-coder-plus")).toBe(1_000_000);
    expect(getContextWindowForModel("qwen3-coder-next")).toBe(262_144);
  });

  test("DeepSeek V4 使用 1M 上下文窗口", () => {
    delete process.env.CONTEXT_WINDOW;
    expect(getContextWindowForModel("deepseek-v4-pro")).toBe(1_000_000);
    expect(getContextWindowForModel("deepseek-v4-flash")).toBe(1_000_000);
  });

  test("中转站未知模型保守回退到 128K", () => {
    delete process.env.CONTEXT_WINDOW;
    expect(getContextWindowForModel("provider-specific-model")).toBe(128_000);
  });

  test("环境变量可以覆盖窗口和 auto-compact 阈值", () => {
    process.env.CONTEXT_WINDOW = "64000";
    process.env.AUTO_COMPACT_THRESHOLD = "30000";
    expect(getContextWindowForModel("glm-test")).toBe(64_000);
    expect(getAutoCompactThreshold("glm-test")).toBe(30_000);
  });

  test("达到阈值时进入 critical 和 autoCompact", () => {
    process.env.AUTO_COMPACT_THRESHOLD = "100";
    const state = getTokenWarningState(100, "glm-test");
    expect(state.autoCompact).toBe(true);
    expect(state.critical).toBe(true);
  });
});
