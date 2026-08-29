import { describe, expect, test } from "bun:test";
import { QueryGuard } from "../../src/ui/turn/queryGuard.js";

describe("QueryGuard", () => {
  test("reserve 覆盖 dispatching 空窗并阻止重复预留", () => {
    const guard = new QueryGuard();
    expect(guard.status).toBe("idle");
    expect(guard.reserve()).toBe(true);
    expect(guard.status).toBe("dispatching");
    expect(guard.isActive).toBe(true);
    expect(guard.reserve()).toBe(false);
  });

  test("reservation 可以取消", () => {
    const guard = new QueryGuard();
    guard.reserve();
    expect(guard.cancelReservation()).toBe(true);
    expect(guard.status).toBe("idle");
    expect(guard.cancelReservation()).toBe(false);
  });

  test("tryStart 支持 direct 与 reserved 两种入口", () => {
    const direct = new QueryGuard();
    expect(direct.tryStart()).toBe(1);
    expect(direct.status).toBe("running");
    expect(direct.tryStart()).toBeNull();

    const reserved = new QueryGuard();
    reserved.reserve();
    expect(reserved.tryStart()).toBe(1);
    expect(reserved.status).toBe("running");
  });

  test("generation 阻止 stale finally 清理当前任务", () => {
    const guard = new QueryGuard();
    const generation = guard.tryStart()!;
    expect(guard.end(generation + 1)).toBe(false);
    expect(guard.status).toBe("running");
    expect(guard.end(generation)).toBe(true);
    expect(guard.status).toBe("idle");

    const nextGeneration = guard.tryStart()!;
    expect(nextGeneration).toBe(generation + 1);
    expect(guard.end(generation)).toBe(false);
    expect(guard.status).toBe("running");
  });

});
