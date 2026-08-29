import { describe, expect, test } from "bun:test";
import {
  formatTerminalCursorWrite,
  TERMINAL_CURSOR_ANCHOR_MARKER,
} from "../../src/ui/input/terminalCursor.js";

describe("terminal IME cursor anchor", () => {
  test("移除零宽 marker 并把帧末物理光标移回输入位置", () => {
    const frame = [
      "message",
      `❯ abc${TERMINAL_CURSOR_ANCHOR_MARKER} `,
      "────────",
      "glm-5.2 | /project | new session",
      "? shortcuts · esc to cancel",
      "",
    ].join("\n");

    const formatted = formatTerminalCursorWrite(frame, false);
    expect(formatted.anchored).toBe(true);
    expect(formatted.output).not.toContain(TERMINAL_CURSOR_ANCHOR_MARKER);
    expect(formatted.output).toEndWith("\u001B7\u001B[4A\u001B[6G");
  });

  test("下一次 Ink 写入前先恢复帧末位置", () => {
    const formatted = formatTerminalCursorWrite("next frame", true);

    expect(formatted).toEqual({
      output: "\u001B8next frame",
      anchored: false,
    });
  });
});
