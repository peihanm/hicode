import {afterEach, expect, spyOn, test} from "bun:test";
import {TurnTiming} from "../../src/runtime/turnTiming.js";
import {decodeSessionContentBlock} from "../../src/session/codec.js";

let now = 0;
let clock: ReturnType<typeof spyOn> | undefined;
afterEach(() => clock?.mockRestore());
function timer() {
    now = 0;
    clock = spyOn(performance, "now").mockImplementation(() => now);
    return new TurnTiming();
}

test("同类并行取区间并集，不同类重叠单列，所有桶恰好覆盖经过时间", () => {
    const timing = timer();
    now = 10; timing.change("model", "start");
    now = 110; timing.change("model", "end");
    timing.change("tool", "start");
    now = 120; timing.change("tool", "start");
    now = 130; timing.change("approval", "start");
    now = 160; timing.change("tool", "end");
    now = 170; timing.change("tool", "end");
    now = 200; timing.change("approval", "end");
    now = 210;
    expect(timing.finish()).toEqual({durationMs: 210, modelMs: 100, toolMs: 20,
        approvalMs: 30, overlapMs: 40, otherMs: 20});
    now = 1000; timing.change("tool", "start");
    expect(timing.finish().durationMs).toBe(210);
});

test("权限回调抛错仍结束等待区间，新 Turn 不继承旧计数", async () => {
    const timing = timer();
    await expect(timing.measure("approval", async () => {
        now = 50;
        throw new Error("cancelled");
    })).rejects.toThrow("cancelled");
    now = 70;
    expect(timing.finish()).toEqual({durationMs: 70, modelMs: 0, toolMs: 0,
        approvalMs: 50, overlapMs: 0, otherMs: 20});
    const next = new TurnTiming();
    now = 80;
    expect(next.finish().otherMs).toBe(10);
});

test("活动中取消时冻结尚未结束的区间，迟到回调不改写结果", () => {
    const timing = timer();
    timing.change("model", "start");
    now = 300;
    expect(timing.finish().modelMs).toBe(300);
    now = 900; timing.change("model", "end");
    expect(timing.finish().modelMs).toBe(300);
});

test("持久化计时拒绝负数、非有限值、超限和无法对账的总数", () => {
    const timing = {durationMs: 10, modelMs: 10, toolMs: 0, approvalMs: 0, overlapMs: 0, otherMs: 0};
    const block = (value: unknown) => ({kind: "ui", value: {version: 1, type: "turn_timing",
        turnId: "turn", timestamp: "2026-09-06T00:00:00.000Z", timing: value}});
    expect(decodeSessionContentBlock(block(timing))).toMatchObject({kind: "ui", value: {timing}});
    for (const modelMs of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 9, 10.5]) {
        expect(() => decodeSessionContentBlock(block({...timing, modelMs}))).toThrow();
    }
});
