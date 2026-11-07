import {expect, test} from "bun:test";
import {DEFAULT_CONTEXT_SETTINGS, getContextBudget, getTokenWarningState, validateContextSettings} from "../../src/context/budget.js";

test("默认配置仍为 50 万窗口、45 万压缩阈值，并为输出保留容量", () => {
    expect(DEFAULT_CONTEXT_SETTINGS).toEqual({windowTokens: 500_000, autoCompactTokenLimit: 450_000});
    const budget = getContextBudget();
    expect(budget.inputTokens).toBe(480_000);
    expect(budget.compactThreshold).toBe(450_000);
    expect(getTokenWarningState(429_999, budget).warning).toBe(false);
    expect(getTokenWarningState(430_000, budget).warning).toBe(true);
    expect(getTokenWarningState(449_999, budget).critical).toBe(false);
    expect(getTokenWarningState(450_000, budget).critical).toBe(true);
    expect(getTokenWarningState(240_000, budget).percentUsed).toBe(0.5);
});

test.each([
    {windowTokens: 4096, autoCompactTokenLimit: 3000},
    {windowTokens: 12_000, autoCompactTokenLimit: 8000},
    {windowTokens: 128_000, autoCompactTokenLimit: 95_000},
    {windowTokens: 1_000_000, autoCompactTokenLimit: 900_000},
    {windowTokens: 500_000, autoCompactTokenLimit: 50_000},
])("显式大小窗口及低触发阈值都保留压缩后的工作空间：%j", settings => {
    const budget = getContextBudget(validateContextSettings(settings));
    expect(budget.inputTokens).toBeLessThan(settings.windowTokens);
    expect(budget.compactThreshold).toBeLessThan(budget.inputTokens);
    expect(budget.compactThreshold).toBeLessThanOrEqual(settings.autoCompactTokenLimit);
    expect(budget.compactTarget).toBeGreaterThan(0);
    expect(budget.compactTarget).toBeLessThan(budget.compactThreshold);
    expect(getTokenWarningState(budget.inputTokens * 2, budget).percentUsed).toBe(1);
});

test("配置不能挤占输出预留或接受非法字段", () => {
    for (const value of [
        {windowTokens: 4096, autoCompactTokenLimit: 4096},
        {windowTokens: 0, autoCompactTokenLimit: 1},
        {...DEFAULT_CONTEXT_SETTINGS, autoCompactTokenLimit: 0},
        {...DEFAULT_CONTEXT_SETTINGS, model: "guessed-window"},
    ]) expect(() => validateContextSettings(value)).toThrow();
});
