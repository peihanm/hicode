import {expect, test} from "bun:test";
import type {Message, ToolCall} from "../../src/llm/types.js";
import {selectCompactedHistory} from "../../src/context/selection.js";
import {hasCompleteToolPairs} from "../../src/session/store/codec.js";

const system = {role: "system", content: "system"} as const;
function select(conversation: Message[], target: number) {
    return selectCompactedHistory({history: [system, ...conversation], system,
        summaryMessage: {role: "user", origin: "compaction", content: "summary"},
        latestUserIndex: -1, fixedTokens: 5, summaryTokens: 4, target, actualPreTokens: 100000});
}
const toolCall = (id: string): ToolCall => ({id, type: "function", function: {name: "read_file", arguments: "{}"}});

test("尾部保留近期消息，并在预算不足时缩小而非超限", () => {
    const messages: Message[] = Array.from({length: 10}, (_, index) => ({role: "assistant", content: `${index}:` + "x".repeat(18)}));
    expect(select(messages, 100)?.slice(2)).toEqual(messages.slice(-5));
    expect(select(messages, 20)?.slice(2)).toEqual(messages.slice(-1));
    expect(select(messages, 0)).toBeUndefined();
});

test("多个 tool call/result 整组保留，超预算时整组交给摘要", () => {
    const messages: Message[] = [{role: "assistant", content: null, tool_calls: [toolCall("a"), toolCall("b")]},
        {role: "tool", content: "a-result", tool_call_id: "a"}, {role: "tool", content: "b-result", tool_call_id: "b"}];
    const large = select(messages, 1000)!;
    expect(large.slice(2)).toEqual(messages);
    expect(hasCompleteToolPairs(large)).toBe(true);
    const small = select(messages, 20)!;
    expect(small).toHaveLength(2);
    expect(hasCompleteToolPairs(small)).toBe(true);
});

test("孤儿结果、遗漏结果与重复结果不能进入候选上下文", () => {
    expect(() => select([{role: "tool", content: "orphan", tool_call_id: "missing"}], 1000)).toThrow("unpaired");
    expect(() => select([{role: "assistant", content: null, tool_calls: [toolCall("missing")]}], 1000)).toThrow("missing");
    expect(() => select([{role: "assistant", content: null, tool_calls: [toolCall("a"), toolCall("b")]},
        {role: "tool", content: "a", tool_call_id: "a"}, {role: "tool", content: "a again", tool_call_id: "a"}], 1000)).toThrow("pairing");
});
