import { describe, expect, test } from "bun:test";
import {
  createTerminalCursorOutput,
  formatTerminalCursorWrite,
  TERMINAL_CURSOR_ANCHOR_MARKER,
} from "../../src/ui/input/terminalCursor.js";
import {EventEmitter} from "node:events";

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

  test("resize 不在 stdout 代理中抢先写屏幕，由 transcript owner 统一重放", () => {
    let columns = 20;
    const writes: string[] = [];
    const target = new EventEmitter() as NodeJS.WriteStream;
    Object.defineProperty(target, "columns", {get: () => columns});
    target.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as NodeJS.WriteStream["write"];
    const output = createTerminalCursorOutput(target);

    output.write(`❯ abc${TERMINAL_CURSOR_ANCHOR_MARKER} cursor and long text\nstatus line is also long\n`);
    columns = 10;
    target.emit("resize");
    columns = 8;
    target.emit("resize");
    output.write("next frame");

    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe("\u001B8next frame");
    expect(writes.every((value) => !value.includes("\u001B[3J"))).toBe(true);
  });

  test("宽度变化但旧帧无需 reflow 时不主动清屏", () => {
    let columns = 100;
    const writes: string[] = [];
    const target = new EventEmitter() as NodeJS.WriteStream;
    Object.defineProperty(target, "columns", {get: () => columns});
    target.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as NodeJS.WriteStream["write"];
    const output = createTerminalCursorOutput(target);

    output.write(`❯ ${TERMINAL_CURSOR_ANCHOR_MARKER}short\nstatus\n`);
    columns = 80;
    target.emit("resize");

    expect(writes).toHaveLength(1);
  });

  test("输出代理屏蔽 Ink 5 的首个 resize listener，只转发 Pillar listener", () => {
    const target = new EventEmitter() as NodeJS.WriteStream;
    target.write = (() => true) as NodeJS.WriteStream["write"];
    const output = createTerminalCursorOutput(target);
    let inkCalls = 0;
    let pillarCalls = 0;

    output.on("resize", () => inkCalls += 1);
    output.on("resize", () => pillarCalls += 1);
    target.emit("resize");

    expect(inkCalls).toBe(0);
    expect(pillarCalls).toBe(1);
    output.disposeCursorOutput();
    expect(target.listenerCount("resize")).toBe(1);
  });

  test("真实 TTY 保留主屏幕 scrollback，不切换 alternate screen", () => {
    const writes: string[] = [];
    const target = new EventEmitter() as NodeJS.WriteStream;
    Object.defineProperty(target, "isTTY", {value: true});
    target.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as NodeJS.WriteStream["write"];

    const output = createTerminalCursorOutput(target);
    expect(writes).toEqual([]);
    output.write(`保留当前可见内容\n\n${TERMINAL_CURSOR_ANCHOR_MARKER}\n\n`);
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain("\u001B[?1049h");
    expect(writes[0]).not.toContain("\u001B[?1007h");
    output.disposeCursorOutput();
    output.disposeCursorOutput();
    expect(writes).toHaveLength(1);
  });
});
