import { describe, expect, test } from "bun:test";
import {
  mapWithConcurrencyLimit,
  partitionToolCalls,
} from "../../src/tools/orchestration.js";
import type { ToolCall } from "../../src/llm/types.js";

function call(name: string): ToolCall {
  return {
    id: name,
    type: "function",
    function: { name, arguments: "{}" },
  };
}

describe("tool orchestration", () => {
  test("连续安全工具合并，非安全工具保持单独批次", () => {
    const batches = partitionToolCalls(
      [call("read-1"), call("read-2"), call("write"), call("read-3")],
      (name) => name.startsWith("read-")
    );

    expect(
      batches.map((batch) => ({
        safe: batch.concurrencySafe,
        names: batch.calls.map((item) => item.function.name),
      }))
    ).toEqual([
      { safe: true, names: ["read-1", "read-2"] },
      { safe: false, names: ["write"] },
      { safe: true, names: ["read-3"] },
    ]);
  });

  test("并发 worker 不超过指定上限并保持返回顺序", async () => {
    let active = 0;
    let maxActive = 0;
    const result = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      return value * 10;
    });

    expect(maxActive).toBe(2);
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });
});
