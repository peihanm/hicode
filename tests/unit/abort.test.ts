import { describe, expect, test } from "bun:test";
import {
  abortableDelay,
  createTurnAbortController,
  isTurnInterruptedError,
  normalizeTurnAbortReason,
  throwIfTurnAborted,
  TurnInterruptedError,
} from "../../src/runtime/abort.js";

describe("abort runtime", () => {
  test("已取消的 turn 抛出标准中断错误", () => {
    const controller = createTurnAbortController();
    controller.abort("sigint");
    expect(() => throwIfTurnAborted(controller.signal)).toThrow(
      expect.objectContaining({
        name: "TurnInterruptedError",
        reason: "sigint",
      })
    );
  });

  test("父 signal 已取消时把底层普通错误归类为中断", () => {
    const controller = createTurnAbortController();
    controller.abort("user-cancel");
    expect(
      isTurnInterruptedError(new Error("fetch failed"), controller.signal)
    ).toBe(true);
  });

  test("abortable delay 响应取消", async () => {
    const controller = createTurnAbortController();
    const pending = abortableDelay(1_000, controller.signal);
    controller.abort("user-cancel");
    await expect(pending).rejects.toEqual(
      expect.objectContaining({
        name: "TurnInterruptedError",
        reason: "user-cancel",
      })
    );
  });

  test("abortable delay 在短命 CLI 中维持等待生命周期", async () => {
    const modulePath = new URL("../../src/runtime/abort.ts", import.meta.url);
    const child = Bun.spawn([
      "bun",
      "-e",
      [
        `import {abortableDelay} from ${JSON.stringify(modulePath.href)};`,
        "const controller = new AbortController();",
        "abortableDelay(30, controller.signal).then(() => console.log('DELAY_DONE'));",
      ].join(" "),
    ], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("DELAY_DONE");
  });

  test("未知 reason 安全回退", () => {
    expect(normalizeTurnAbortReason(new DOMException("aborted"))).toBe("shutdown");
    expect(new TurnInterruptedError("shutdown").reason).toBe("shutdown");
  });
});
