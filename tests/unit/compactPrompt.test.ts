import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  buildCompactPrompt,
  buildCompactSummaryMessage,
  parseCompactSummary,
} from "../../src/context/compactPrompt.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Compact prompt protocol", () => {
  test("默认 prompt 与 custom instructions 保持字节级稳定", () => {
    expect(sha256(buildCompactPrompt())).toBe(
      "f35be77440e297891fa0ea581291b6469f0b715c39ea846fcd365f7517986ab2"
    );
    expect(sha256(buildCompactPrompt("  keep tests  "))).toBe(
      "5be7a851b162580af8a8c66cb65ad0945252c9f3a4392fe51d675347eef8b04a"
    );
    expect(buildCompactPrompt("   ")).toBe(buildCompactPrompt());
  });

  test("解析时移除 analysis、优先 summary tag 并兼容纯文本", () => {
    expect(
      parseCompactSummary(
        "<analysis>draft</analysis>\n<summary>line 1\n\n\nline 2</summary>"
      )
    ).toBe("line 1\n\nline 2");
    expect(parseCompactSummary(" plain summary ")).toBe("plain summary");
    expect(parseCompactSummary("<summary>   </summary>")).toBe(
      "<summary>   </summary>"
    );
  });

  test("summary reminder 保持固定 history 角色与协议边界", () => {
    const message = buildCompactSummaryMessage("current state");
    expect(message.role).toBe("user");
    expect(message.content).toBe(`<system-reminder>
本会话因为接近上下文上限已经被压缩。

下面是较早对话的摘要：

current state

请从对话中断处继续。除非和当前任务直接相关，不要向用户提及这次压缩，也不要重新复述摘要。
</system-reminder>`);
  });
});
