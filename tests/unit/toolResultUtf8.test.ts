import { describe, expect, test } from "bun:test";
import {
  selectUtf8Range,
  trimIncompleteUtf8,
} from "../../src/toolResults/utf8.js";

describe("tool result UTF-8 boundaries", () => {
  test("移除末尾不完整字符但保留完整多字节字符", () => {
    const content = Buffer.from("甲乙", "utf8");
    expect(trimIncompleteUtf8(content.subarray(0, 5)).toString("utf8")).toBe("甲");
    expect(trimIncompleteUtf8(content).toString("utf8")).toBe("甲乙");
  });

  test("range 从 continuation byte 开始时跳到下一个字符", () => {
    const content = Buffer.from("甲乙", "utf8").subarray(1);
    const selected = selectUtf8Range(content, 3);
    expect(selected.startAdjustment).toBe(2);
    expect(selected.content.toString("utf8")).toBe("乙");
  });

  test("limit 小于一个字符时仍扩展到首个完整字符保证进度", () => {
    const selected = selectUtf8Range(Buffer.from("甲乙", "utf8"), 2);
    expect(selected.content.toString("utf8")).toBe("甲");
  });
});
