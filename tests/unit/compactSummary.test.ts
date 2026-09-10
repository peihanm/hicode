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

const archive = {id: "a".repeat(64), createdAt: "2026-09-10T00:00:00.000Z", messages: ["b".repeat(64)]};
const sources = {current: archive, previous: [], revision: 1};
const summaryInput = () => ({system, conversation: [{role: "user" as const, origin: "user" as const, content: "完成网页，不能提交"}],
  sources, signal: new AbortController().signal, cwd: "/tmp/project", model: "deepseek-flash"});
const validHandoff = () => ({version: 1, objective: [{text: "完成网页", sources: [`${archive.id}/1`], basis: "reported"}],
  constraints: [], decisions: [], files: [], verification: [], next: []});

test.each(["missing-basis", "too-many-items"])("交接 %s 时修正一次，继续用同一来源且不执行历史任务", async kind => {
  const invalid = kind === "missing-basis"
    ? {...validHandoff(), objective: [{text: "完成网页", sources: [`${archive.id}/1`]}]}
    : {...validHandoff(), decisions: Array.from({length: 12}, () => validHandoff().objective[0])};
  const fake = createFakeLLM([assistantText(JSON.stringify(invalid)), assistantText(JSON.stringify(validHandoff()))]);
  const input = summaryInput();
  const before = structuredClone(input.conversation);
  const summary = await generateCompactSummary({...input, callLLM: fake.callLLM});
  expect(summary).toContain("来源转述");
  expect(summary).toContain(`[[${archive.id}/1]]`);
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[0]?.tools).toEqual([]);
  expect(fake.calls[0]?.messages[0]?.content).toContain("仅为待总结数据");
  expect(fake.calls[0]?.messages.at(-1)?.content).toContain('"required":["text","sources","basis"]');
  expect(fake.calls[1]?.messages.slice(0, -1)).toEqual(fake.calls[0]?.messages);
  expect(fake.calls[1]?.messages.at(-1)?.content).toContain("上一次交接未通过校验");
  expect(input.conversation).toEqual(before);
});

test("格式修正次数有界，错误摘要不会刷出所有缺字段条目", async () => {
  const invalid = {...validHandoff(), files: Array.from({length: 100}, () => ({text: "x", sources: []}))};
  const fake = createFakeLLM([assistantText(JSON.stringify(invalid)), assistantText(JSON.stringify(invalid))]);
  let caught: unknown;
  try {await generateCompactSummary({...summaryInput(), callLLM: fake.callLLM});} catch (error) {caught = error;}
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("修正后仍无效");
  expect((caught as Error).message.length).toBeLessThan(700);
  expect(fake.calls).toHaveLength(2);
});

test("修正前取消不发起下一次调用", async () => {
  const controller = createTurnAbortController();
  const fake = createFakeLLM([() => {controller.abort("user-cancel"); return assistantText("{}");}]);
  await expect(generateCompactSummary({...summaryInput(), signal: controller.signal, callLLM: fake.callLLM})).rejects.toMatchObject({name: "TurnInterruptedError"});
  expect(fake.calls).toHaveLength(1);
});

test("伪造来源不会自动降级为 inferred 或重试", async () => {
  const invalid = {...validHandoff(), objective: [{text: "完成网页", sources: [`${"c".repeat(64)}/1`], basis: "reported"}]};
  const fake = createFakeLLM([assistantText(JSON.stringify(invalid))]);
  await expect(generateCompactSummary({...summaryInput(), callLLM: fake.callLLM})).rejects.toThrow("不属于当前来源");
  expect(fake.calls).toHaveLength(1);
});
