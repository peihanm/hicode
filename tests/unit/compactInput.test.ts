import {expect, test} from "bun:test";
import {selectCompactInput} from "../../src/context/compactInput.js";
import {buildCompactSummaryMessage} from "../../src/context/compactPrompt.js";
import {getCompactTarget, getModelInputBudget} from "../../src/context/window.js";
import {tokenCountWithEstimation} from "../../src/context/tokens.js";
import {hasCompleteToolPairs} from "../../src/session/codec.js";
import type {Message} from "../../src/llm/types.js";

const system = {role: "system", content: "system"} as const;
function sources(count: number) {
    return {current: {id: "a".repeat(64), createdAt: "2026-09-08T00:00:00.000Z", messages: Array(count).fill("b".repeat(64))},
        previous: [], revision: 2};
}

test("输入预算保留旧交接和最新原话，大工具组整体转为明确来源缺口", () => {
    const conversation: Message[] = [buildCompactSummaryMessage("原始约束仍适用"),
        {role: "user", content: "旧请求"},
        {role: "assistant", content: null, tool_calls: [{id: "read", type: "function", function: {name: "read_file", arguments: "{}"}}]},
        {role: "tool", tool_call_id: "read", content: "超大源码".repeat(10_000)},
        {role: "user", content: "纠正：不得默认丢弃"}, {role: "assistant", content: "准备继续"}];
    const before = structuredClone(conversation);
    const selected = selectCompactInput({system, conversation, prompt: "交接", budget: 2000, sources: sources(conversation.length)});
    expect(tokenCountWithEstimation(selected.messages)).toBeLessThanOrEqual(2000);
    expect(hasCompleteToolPairs(selected.messages)).toBe(true);
    expect(selected.messages.some(message => message.role === "tool")).toBe(false);
    expect(JSON.stringify(selected.messages)).toContain("原始约束仍适用");
    expect(JSON.stringify(selected.messages)).toContain("纠正：不得默认丢弃");
    expect(selected.coverage).toContain(`[[${"a".repeat(64)}/2]]..[[${"a".repeat(64)}/4]]`);
    expect(selected.coverage).toContain("不代表已总结全部会话");
    expect(conversation).toEqual(before);
});

test("无档案或必须保留的原文过长时失败，不能伪造已覆盖", () => {
    const conversation: Message[] = [{role: "user", content: "x".repeat(30_000)}];
    expect(() => selectCompactInput({system, conversation, prompt: "交接", budget: 1000})).toThrow("无来源档案");
    expect(() => selectCompactInput({system, conversation, prompt: "交接", budget: 1000, sources: sources(1)})).toThrow("无法容纳");
});

test("正常输入完整覆盖且不携带隐藏推理，压缩目标独立于触发阈值", () => {
    const conversation: Message[] = [{role: "user", content: "task"}, {role: "assistant", content: "visible", reasoning_content: "private"}];
    const result = selectCompactInput({system, conversation, prompt: "交接", budget: 1000});
    expect(result.coverage).toBe("");
    expect(JSON.stringify(result.messages)).not.toContain("private");
    for (const window of [12_000, 128_000, 1_000_000]) {
        expect(getCompactTarget("unknown", window)).toBe(Math.floor(getModelInputBudget("unknown", window) * 0.65));
    }
});
