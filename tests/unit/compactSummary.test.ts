import { describe, expect, test } from "bun:test";
import {
  generateCompactSummaryForTest as generateCompactSummary,
} from "../helpers/compact.js";
import { createTurnAbortController } from "../../src/runtime/abort.js";
import type { Message } from "../../src/llm/types.js";
import {
  assistantText,
  createFakeLLM,
} from "../helpers/fakeLLM.js";

const system = { role: "system", content: "system" } as const;

function conversation(): Message[] {
  return [
    { role: "user", content: "old-user" },
    { role: "assistant", content: "old-assistant" },
    { role: "user", content: "recent-user" },
    { role: "assistant", content: "recent-assistant" },
  ];
}

describe("Compact summary runner", () => {
  test("prompt-too-long 时从 user boundary 裁剪并重试", async () => {
    const fake = createFakeLLM([
      () => {
        throw new Error("prompt too long: context length limit");
      },
      assistantText("<analysis>draft</analysis><summary>recovered</summary>"),
    ]);
    const summary = await generateCompactSummary({
      system,
      conversation: conversation(),
      signal: new AbortController().signal,
      cwd: "/tmp/project",
      model: "glm-test",
      callLLM: fake.callLLM,
    });

    expect(summary).toBe("recovered");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.messages[1]).toEqual({
      role: "user",
      content: "[为了重试压缩，较早对话已被截断]",
    });
    expect(fake.calls[1]?.messages[2]).toEqual({
      role: "user",
      content: "recent-user",
    });
  });

  test("普通错误不重试，空 summary 明确失败", async () => {
    const network = createFakeLLM([
      () => {
        throw new Error("network unavailable");
      },
    ]);
    await expect(
      generateCompactSummary({
        system,
        conversation: conversation(),
        signal: new AbortController().signal,
        cwd: "/tmp/project",
        model: "glm-test",
        callLLM: network.callLLM,
      })
    ).rejects.toThrow("network unavailable");
    expect(network.calls).toHaveLength(1);

    const empty = createFakeLLM([assistantText(null)]);
    await expect(
      generateCompactSummary({
        system,
        conversation: conversation(),
        signal: new AbortController().signal,
        cwd: "/tmp/project",
        model: "glm-test",
        callLLM: empty.callLLM,
      })
    ).rejects.toThrow("compact summary 为空");
  });

  test("已取消 signal 在调用 LLM 前失败", async () => {
    const controller = createTurnAbortController();
    controller.abort("user-cancel");
    const fake = createFakeLLM([]);
    await expect(
      generateCompactSummary({
        system,
        conversation: conversation(),
        signal: controller.signal,
        cwd: "/tmp/project",
        model: "glm-test",
        callLLM: fake.callLLM,
      })
    ).rejects.toMatchObject({
      name: "TurnInterruptedError",
      reason: "user-cancel",
    });
    expect(fake.calls).toHaveLength(0);
  });

});
