import { describe, expect, test } from "bun:test";
import type { Message, ToolCall } from "../../src/llm/types.js";
import {
  adjustTailStartForToolPairs,
  createCompactTailFinder,
  findCompactTailStart,
} from "../../src/context/compactTail.js";

function toolCall(id: string): ToolCall {
  return {
    id,
    type: "function",
    function: { name: "read_file", arguments: "{}" },
  };
}

const estimateTen = () => 10;
const findTestTailStart = createCompactTailFinder(estimateTen);

describe("Compact recent tail", () => {
  test("同时满足 min tokens/text 后停止，max tokens 可以提前截断", () => {
    const history: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "old" },
      { role: "tool", content: "result", tool_call_id: "unmatched" },
      { role: "assistant", content: "recent" },
    ];
    expect(
      findTestTailStart(history, {
        minTokens: 20,
        minTextMessages: 2,
        maxTokens: 100,
      })
    ).toBe(1);
    expect(
      findTestTailStart(history, {
        minTokens: 100,
        minTextMessages: 10,
        maxTokens: 15,
      })
    ).toBe(2);
  });

  test("tool result 缺少 use 时向前扩展并保留多 call assistant 整组", () => {
    const history: Message[] = [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [toolCall("a"), toolCall("b")],
      },
      { role: "tool", content: "a-result", tool_call_id: "a" },
      { role: "tool", content: "b-result", tool_call_id: "b" },
    ];
    expect(adjustTailStartForToolPairs(history, 4)).toBe(2);
    expect(
      findTestTailStart(history, {
        minTokens: 0,
        minTextMessages: 0,
        maxTokens: 1,
      })
    ).toBe(2);
  });

  test("找不到对应 tool use 时保持原 start，空/禁用预算不保留 tail", () => {
    const history: Message[] = [
      { role: "system", content: "system" },
      { role: "tool", content: "orphan", tool_call_id: "missing" },
    ];
    expect(adjustTailStartForToolPairs(history, 1)).toBe(1);
    expect(
      findCompactTailStart(history, {
        minTokens: 0,
        minTextMessages: 0,
        maxTokens: 0,
      })
    ).toBe(history.length);
  });
});
