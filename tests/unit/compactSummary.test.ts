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
    { role: "user", origin: "user" as const, content: "old-user" },
    { role: "assistant", content: "old-assistant" },
    { role: "user", origin: "user" as const, content: "recent-user" },
    { role: "assistant", content: "recent-assistant" },
  ];
}

describe("Compact summary runner", () => {
  test("Provider 超长失败不裁剪原对话或进行第二次请求", async () => {
    const fake = createFakeLLM([() => {throw new Error("prompt too long: context length limit");}]);
    const messages = conversation();
    const before = structuredClone(messages);
    await expect(generateCompactSummary({system, conversation: messages, signal: new AbortController().signal,
      cwd: "/tmp/project", model: "glm-test", callLLM: fake.callLLM})).rejects.toThrow("prompt too long");
    expect(fake.calls).toHaveLength(1);
    expect(messages).toEqual(before);
    expect(fake.calls[0]?.messages[1]).toEqual(messages[0]);
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
