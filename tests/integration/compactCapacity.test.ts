import {withExecutionContext} from "../../src/prompt/collaboration.js";
import {buildInvokeMessages} from "../../src/prompt/invokeMessages.js";
import {getUserContextBlocks} from "../../src/prompt/attachments.js";
import {tokenCountWithEstimation} from "../../src/context/tokens.js";
import {DEFAULT_CONTEXT_SETTINGS} from "../../src/context/config.js";
import {expect, test} from "bun:test";
import {createCompactHistoryRunner} from "../../src/context/compact.js";
import {prepareAgentInvoke} from "../../src/agent/invokePreparation.js";
import {findCompactTailStart} from "../../src/context/compactTail.js";
import type {Message} from "../../src/llm/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestContext} from "../helpers/testContext.js";

function largeHistory(): Message[] {
    return [{role: "system", content: "system"}, {role: "user", origin: "user" as const, content: "old"},
        {role: "assistant", content: "old reply"}, {role: "user", origin: "user" as const, content: "x".repeat(300_000)}];
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
    const history: Message[] = [{role: "system", content: "system"}, {role: "user", origin: "user" as const, content: "task"},
        {role: "assistant", content: null, tool_calls: [{id: "call", type: "function", function: {name: "read_file", arguments: "{}"}}]},
        {role: "tool", tool_call_id: "call", content: "x".repeat(20_000)}];
    expect(findCompactTailStart(history, {minTokens: 1, minTextMessages: 1, maxTokens: 100})).toBe(history.length);
});

test("摘要变长不能覆盖原历史或增加成功计数", async () => {
    await withTempProject(async cwd => {
        const history: Message[] = [{role: "system", content: "system"}, {role: "user", origin: "user" as const, content: "old"},
            {role: "assistant", content: "old reply"}, {role: "user", origin: "user" as const, content: "current task"}];
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
import {createCompactSummaryGenerator} from "../../src/context/compactSummary.js";

test("按 Provider 小窗口与附加指令分配预算，最新任务仍保留原文", async () => {
    await withTempProject(async cwd => {
        const current = "CURRENT_TASK_".repeat(150);
        const history: Message[] = [{role: "system", content: "system"}, {role: "user", origin: "user" as const, content: "old".repeat(8_000)},
            {role: "assistant", content: "old answer"}, {role: "user", origin: "user" as const, content: current}];
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
        const history: Message[] = [{role: "system", content: "system"}, {role: "user", origin: "user" as const, content: "old"},
            {role: "assistant", content: "old"}, {role: "user", origin: "user" as const, content: "current"}];
        await expect(prepareAgentInvoke({history, ctx, contextWindow: 12_000,
            additionalUserContextBlocks: ["instruction".repeat(3_000)], onEvent() {}, getToolSchemas: () => [], compactHistory})).rejects.toThrow("model request stopped");
        ctx.compactState.consecutiveFailures = 3;
        await expect(prepareAgentInvoke({history: largeHistory(), ctx, onEvent() {}, getToolSchemas: () => [], compactHistory})).rejects.toThrow("model request stopped");
        expect(summaries).toBe(0);
    });
});

test("Summary 本身也不会发送已知超限请求", async () => {
    await withTempProject(async (cwd, storage) => {
        let requests = 0;
        const summarize = createCompactSummaryGenerator({async callLLM() { requests++; throw new Error("unexpected request"); }});
        await expect(summarize({contextSettings: DEFAULT_CONTEXT_SETTINGS, system: {role: "system", content: "system"},
            conversation: [{role: "user", origin: "user" as const, content: "x".repeat(300_000)}], signal: new AbortController().signal,
            storage, cwd, model: "glm-test"})).rejects.toThrow("estimated input exceeds budget");
        expect(requests).toBe(0);
    });
});

test("压缩后从 Host 重新装配当前 Todo，不把运行时状态写入 History", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd);
        const history = largeHistory();
        let phase: "pending" | "completed" = "pending";
        const prepared = await prepareAgentInvoke({history, ctx, onEvent() {}, getToolSchemas: () => [],
            getTodos: () => [{content: "CURRENT_TODO_DATA", status: phase, activeForm: "执行任务"}],
            compactHistory: async () => {
                history.splice(1, history.length - 1, {role: "user", origin: "user" as const, content: "恢复工作"});
                phase = "completed";
                return {compacted: true, preTokenCount: 100_000, postTokenCount: 1, threshold: 50_000};
            }});
        expect(JSON.stringify(prepared.invokeMessages)).toContain("completed");
        expect(JSON.stringify(prepared.invokeMessages)).toContain("CURRENT_TODO_DATA");
        expect(JSON.stringify(history)).not.toContain("CURRENT_TODO_DATA");
        expect(String(prepared.invokeMessages[0]?.content).match(/<execution_context>/g)).toHaveLength(1);
        expect(JSON.stringify(history)).not.toContain("execution_context");
    });
});

test("近期 ask_user 回答以完整工具组保留，旧源码观察不会随交接复活", async () => {
    await withTempProject(async cwd => {
        const history: Message[] = [{role: "system", content: "system"}, {role: "user", origin: "user" as const, content: "原始目标"},
            {role: "assistant", content: null, tool_calls: [{id: "question", type: "function", function: {name: "ask_user", arguments: '{"questions":[{"question":"删除策略"}]}'}}]},
            {role: "tool", tool_call_id: "question", content: "允许显式丢弃，默认不丢弃"},
            {role: "assistant", content: "旧源码\n".repeat(25_000)}, {role: "user", origin: "user" as const, content: "继续"}];
        const ctx = createTestContext(cwd);
        const compact = createCompactHistoryRunner({async generateSummary() {return "交接";}});
        expect((await compact({history, ctx, tools: [], preTokenCount: 100_000, force: true})).compacted).toBe(true);
        const call = history.findIndex(message => message.role === "assistant" && message.tool_calls?.[0]?.id === "question");
        expect(call).toBeGreaterThan(0);
        expect(history[call + 1]).toEqual({role: "tool", tool_call_id: "question", content: "允许显式丢弃，默认不丢弃"});
        expect(JSON.stringify(history)).not.toContain("旧源码");
    });
});


test("压缩计入实际模式与权限说明，但只持久化原始 system", async () => {
    await withTempProject(async cwd => {
        const ctx = createTestContext(cwd, {permissionMode: "auto-review", permissionPromptPolicy: "never", collaborationMode: "plan"});
        const history: Message[] = [{role: "system", content: "unchanged system"},
            {role: "user", origin: "user", content: "旧请求"},
            {role: "assistant", content: "old material ".repeat(12000)},
            {role: "user", origin: "user", content: "保留当前请求"}];
        const compact = createCompactHistoryRunner({async generateSummary() {return "有界交接";}});
        const result = await compact({history, ctx, tools: [], preTokenCount: 100000, force: true});
        expect(result.compacted).toBe(true);
        const actual = withExecutionContext(buildInvokeMessages(history, getUserContextBlocks(ctx.skills, ctx.instructions)), ctx);
        expect(result.postTokenCount).toBe(tokenCountWithEstimation(actual, []));
        expect(String(actual[0]?.content)).toContain("independent approval reviewer");
        expect(String(actual[0]?.content)).toContain("no interactive approval channel");
        expect(String(actual[0]?.content)).toContain("Current mode: Plan");
        expect(history[0]?.content).toBe("unchanged system");
    });
});
