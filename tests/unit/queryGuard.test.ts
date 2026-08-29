import { describe, expect, test } from "bun:test";
import { QueryGuard } from "../../src/ui/turn/queryGuard.js";

describe("QueryGuard", () => {
  test("reserve 覆盖 dispatching 空窗并阻止重复预留", () => {
    const guard = new QueryGuard();
    expect(guard.reserve()).toBe(true);
    expect(guard.reserve()).toBe(false);
  });

  test("reservation 可以取消", () => {
    const guard = new QueryGuard();
    guard.reserve();
    expect(guard.cancelReservation()).toBe(true);
    expect(guard.cancelReservation()).toBe(false);
    expect(guard.reserve()).toBe(true);
  });

  test("tryStart 支持 direct 与 reserved 两种入口", () => {
    const direct = new QueryGuard();
    expect(direct.tryStart()).toBe(1);
    expect(direct.tryStart()).toBeNull();

    const reserved = new QueryGuard();
    reserved.reserve();
    expect(reserved.tryStart()).toBe(1);
    expect(reserved.tryStart()).toBeNull();
  });

  test("generation 阻止 stale finally 清理当前任务", () => {
    const guard = new QueryGuard();
    const generation = guard.tryStart()!;
    expect(guard.end(generation + 1)).toBe(false);
    expect(guard.tryStart()).toBeNull();
    expect(guard.end(generation)).toBe(true);

    const nextGeneration = guard.tryStart()!;
    expect(nextGeneration).toBe(generation + 1);
    expect(guard.end(generation)).toBe(false);
    expect(guard.tryStart()).toBeNull();
  });

});
