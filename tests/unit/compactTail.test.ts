import { describe, expect, test } from "bun:test";
import type { Message, ToolCall } from "../../src/llm/types.js";
import {
  findCompactTailStart,
} from "../../src/context/compactTail.js";

function toolCall(id: string): ToolCall {
  return {
    id,
    type: "function",
    function: { name: "read_file", arguments: "{}" },
  };
}

describe("Compact recent tail", () => {
  test("同时满足 min tokens/text 后停止，max tokens 可以提前截断", () => {
    const history: Message[] = [
      { role: "system", content: "system" },
      { role: "user", origin: "user" as const, content: "old" },
      { role: "assistant", content: "result" },
      { role: "assistant", content: "recent" },
    ];
    expect(
      findCompactTailStart(history, {
        minTokens: 5,
        minTextMessages: 2,
        maxTokens: 100,
      })
    ).toBe(2);
    expect(
      findCompactTailStart(history, {
        minTokens: 100,
        minTextMessages: 10,
        maxTokens: 4,
      })
    ).toBe(3);
  });

  test("tool call/result 整组在预算内保留，超限不拆分", () => {
    const history: Message[] = [
      { role: "system", content: "system" },
      { role: "user", origin: "user" as const, content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("a"), toolCall("b")],
      },
      { role: "tool", content: "a-result", tool_call_id: "a" },
      { role: "tool", content: "b-result", tool_call_id: "b" },
    ];
    expect(
      findCompactTailStart(history, {
        minTokens: 0,
        minTextMessages: 0,
        maxTokens: 1,
      })
    ).toBe(history.length);
    expect(findCompactTailStart(history, {minTokens: 0, minTextMessages: 0, maxTokens: 1_000})).toBe(2);
  });

  test("空/禁用预算不保留 tail；孤儿结果与缺失结果不能进入 tail", () => {
    const history: Message[] = [
      { role: "system", content: "system" },
      { role: "tool", content: "orphan", tool_call_id: "missing" },
    ];
    expect(
      findCompactTailStart(history, {
        minTokens: 0,
        minTextMessages: 0,
        maxTokens: 0,
      })
    ).toBe(history.length);
    expect(() => findCompactTailStart(history, {minTokens: 0, minTextMessages: 0, maxTokens: 100})).toThrow("unpaired");
    expect(() => findCompactTailStart([history[0]!, {role: "assistant", content: null, tool_calls: [toolCall("missing")]}],
      {minTokens: 0, minTextMessages: 0, maxTokens: 100})).toThrow("missing");
  });
});
