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

  test("未知 reason 安全回退", () => {
    expect(normalizeTurnAbortReason(new DOMException("aborted"))).toBe("shutdown");
    expect(new TurnInterruptedError("shutdown").reason).toBe("shutdown");
  });
});
