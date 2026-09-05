import {expect, test} from "bun:test";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {prepareAgentInvoke} from "../../src/agent/invokePreparation.js";
import {findCompactTailStart} from "../../src/context/compactTail.js";
import type {Message} from "../../src/llm/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";

function largeHistory(): Message[] {
    return [{role: "system", content: "system"}, {role: "user", content: "old"},
        {role: "assistant", content: "old reply"}, {role: "user", content: "x".repeat(300_000)}];
}

test("不可容纳的最新任务不能计为压缩成功或发给主模型", async () => {
    await withTempProject(async cwd => {
        const history = largeHistory();
        const before = structuredClone(history);
        const ctx = createTestContext(cwd);
        let summaries = 0;
        const compactHistory = createCompactHistoryRunner({async generateSummary() { summaries++; return "short summary"; }});
        await expect(prepareAgentInvoke({history, ctx, onEvent() {}, getToolSchemas: () => [], compactHistory})).rejects.toThrow();
        expect(history).toEqual(before);
        expect(ctx.compactState.compactCount).toBe(0);
        expect(summaries).toBe(0);
    });
});

test("配对修正不能把 tail 扩到预算之外", () => {
    const history: Message[] = [{role: "system", content: "system"}, {role: "user", content: "task"},
        {role: "assistant", content: null, tool_calls: [{id: "call", type: "function", function: {name: "read_file", arguments: "{}"}}]},
        {role: "tool", tool_call_id: "call", content: "x".repeat(20_000)}];
    expect(findCompactTailStart(history, {minTokens: 1, minTextMessages: 1, maxTokens: 100})).toBe(history.length);
});

test("摘要变长不能覆盖原历史或增加成功计数", async () => {
    await withTempProject(async cwd => {
        const history: Message[] = [{role: "system", content: "system"}, {role: "user", content: "old"},
            {role: "assistant", content: "old reply"}, {role: "user", content: "current task"}];
        const before = structuredClone(history);
        const ctx = createTestContext(cwd);
        const compact = createCompactHistoryRunner({async generateSummary() { return "x".repeat(20_000); }});
        const result = await compact({history, ctx, tools: [], preTokenCount: 100_000, force: true});
        expect(result.compacted).toBe(false);
        expect(history).toEqual(before);
        expect(ctx.compactState.compactCount).toBe(0);
    });
});

import {getAutoCompactThreshold} from "../../src/context/window.js";
import {tokenCountWithEstimation} from "../../src/context/tokens.js";
import {createCompactSummaryGenerator} from "../../src/context/compactSummary.js";

test("按 Provider 小窗口与附加指令分配预算，最新任务仍保留原文", async () => {
    await withTempProject(async cwd => {
        const current = "CURRENT_TASK_".repeat(150);
        const history: Message[] = [{role: "system", content: "system"}, {role: "user", content: "old".repeat(8_000)},
            {role: "assistant", content: "old answer"}, {role: "user", content: current}];
        const ctx = createTestContext(cwd);
        const compactHistory = createCompactHistoryRunner({async generateSummary() { return "summary"; }});
        const result = await prepareAgentInvoke({history, ctx, contextWindow: 12_000,
            additionalUserContextBlocks: ["instruction".repeat(300)], onEvent() {}, getToolSchemas: () => [], compactHistory});
        expect(result.estimatedTokens).toBeLessThan(getAutoCompactThreshold(ctx.model, 12_000));
        expect(history.some(message => message.role === "user" && message.content === current)).toBe(true);
        expect(result.estimatedTokens).toBe(tokenCountWithEstimation(result.invokeMessages, result.tools));
        expect(ctx.compactState.compactCount).toBe(1);
    });
});

test("固定指令占满窗口或熔断后的超限请求不会继续提交", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        let summaries = 0;
        const compactHistory = createCompactHistoryRunner({async generateSummary() { summaries++; return "summary"; }});
        const history: Message[] = [{role: "system", content: "system"}, {role: "user", content: "old"},
            {role: "assistant", content: "old"}, {role: "user", content: "current"}];
        await expect(prepareAgentInvoke({history, ctx, contextWindow: 12_000,
            additionalUserContextBlocks: ["instruction".repeat(3_000)], onEvent() {}, getToolSchemas: () => [], compactHistory})).rejects.toThrow("已停止调用模型");
        ctx.compactState.consecutiveFailures = 3;
        await expect(prepareAgentInvoke({history: largeHistory(), ctx, onEvent() {}, getToolSchemas: () => [], compactHistory})).rejects.toThrow("已停止调用模型");
        expect(summaries).toBe(0);
    });
});

test("Summary 本身也不会发送已知超限请求", async () => {
    await withTempProject(async (cwd, storage) => {
        let requests = 0;
        const summarize = createCompactSummaryGenerator({async callLLM() { requests++; throw new Error("unexpected request"); }});
        await expect(summarize({system: {role: "system", content: "system"},
            conversation: [{role: "user", content: "x".repeat(300_000)}], signal: new AbortController().signal,
            storage, cwd, model: "glm-test"})).rejects.toThrow("估算已超过输入预算");
        expect(requests).toBe(0);
    });
});
