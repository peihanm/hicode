import {describe, expect, test} from "bun:test";
import {normalizeInteractionResponse, raceInteractionWithAbort, requestHostInteraction} from "../../src/sdk/interaction.js";

describe("SDK network response validation", () => {
    test("答案使用独立字段，拒绝无效答案和问题参数替换", () => {
        expect(normalizeInteractionResponse({behavior: "allow", answers: {"Question": "回答"}}))
            .toEqual({behavior: "allow", answers: {"Question": "回答"}});
        for (const answers of [null, [], {}, {"Question": 42}, {"Question": " "}, {"Question": "a".repeat(16_385)}]) {
            expect(normalizeInteractionResponse({behavior: "allow", answers}).behavior).toBe("deny");
        }
        expect(normalizeInteractionResponse({behavior: "allow", updatedInput: {questions: []}}).behavior).toBe("deny");
        expect(normalizeInteractionResponse({behavior: "allow", networkScope: "once", answers: {"Question": "回答"}}).behavior).toBe("deny");
    });
    test("允许单连接和会话 scope，不静默扩展范围", () => {
        for (const networkScope of ["once", "session"] as const) {
            const response = {behavior: "allow", networkScope} as const;
            expect(normalizeInteractionResponse(response)).toEqual(response);
        }
        expect(normalizeInteractionResponse({behavior: "allow"})).toEqual({behavior: "allow"});
    });
    test("拒绝无效 scope 及混用持久化/目录授权", () => {
        for (const extra of [
            {networkScope: "project"}, {networkScope: true}, {networkScope: null},
            {networkScope: "session", directoryScope: "once"},
            {networkScope: "session", persistence: "always"},
        ]) {
            expect(normalizeInteractionResponse({behavior: "allow", ...extra}).behavior).toBe("deny");
        }
    });
});

test("预取消和调用前取消均不打开 Host 交互", async () => {
    const controller = new AbortController();
    let calls = 0;
    const operation = async () => { calls++; return "allow"; };
    const pending = raceInteractionWithAbort(operation, controller.signal);
    controller.abort("shutdown");
    await expect(pending).rejects.toThrow("cancelled");
    await expect(raceInteractionWithAbort(operation, controller.signal)).rejects.toThrow("cancelled");
    expect(calls).toBe(0);
});

test.each([false, true])("Host 完成或异常后请求资源均关闭，owner 保持有效：%s", async fail => {
    const owner = new AbortController();
    const signals: AbortSignal[] = [];
    let closed = 0;
    const pending = raceInteractionWithAbort(async signal => {
        signals.push(signal);
        expect(signal.aborted).toBe(false);
        signal.addEventListener("abort", () => closed++, {once: true});
        if (fail) throw new Error("host failed");
        return "allow";
    }, owner.signal);
    if (fail) await expect(pending).rejects.toThrow("host failed");
    else expect(await pending).toBe("allow");
    expect(signals[0]?.aborted).toBe(true);
    expect(owner.signal.aborted).toBe(false);
    owner.abort();
    expect(closed).toBe(1);
});

test("等待中取消通知 Host，迟到批准不能完成请求", async () => {
    const owner = new AbortController();
    let finish!: (value: string) => void;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let closed = 0;
    const pending = raceInteractionWithAbort(signal => {
        signal.addEventListener("abort", () => closed++, {once: true});
        ready();
        return new Promise<string>(resolve => { finish = resolve; });
    }, owner.signal);
    await started;
    owner.abort("shutdown");
    finish("allow");
    await expect(pending).rejects.toThrow("cancelled");
    expect(closed).toBe(1);
});

test("SDK accepts structured multiple answers and rejects invalid arrays", () => {
    const response = {behavior: "allow" as const, answers: {Platforms: ["Linux", "macOS"]}};
    expect(normalizeInteractionResponse(response)).toEqual(response);
    for (const answer of [[], ["A", "A"], [" "], [1], ["A", "B", "C", "D", "E", "F"]]) {
        expect(normalizeInteractionResponse({behavior: "allow", answers: {Platforms: answer}}).behavior).toBe("deny");
    }
});


test("shared Host invocation fails closed without a handler or when Host/diagnostic throws", async () => {
    const request = {kind: "permission", requestId: "request", toolName: "bash", message: "approve", input: {}} as const;
    const context = {cwd: "/tmp", signal: new AbortController().signal};
    expect((await requestHostInteraction(undefined, request, context)).behavior).toBe("deny");
    const response = await requestHostInteraction({
        onInteraction: async () => { throw new Error("host failure"); },
        onDiagnostic: () => { throw new Error("diagnostic failure"); },
    }, request, context);
    expect(response).toEqual({behavior: "deny", message: "SDK Host interaction failed: host failure"});
});

test("shared Host invocation passes root/Turn context and rejects late approval", async () => {
    for (const identity of [{}, {threadId: "thread", turnId: "turn"}]) {
        const owner = new AbortController();
        const response = await requestHostInteraction({onInteraction: async (_request, context) => {
            expect(context.threadId).toBe(identity.threadId);
            expect(context.turnId).toBe(identity.turnId);
            expect(context.cwd).toBe("/tmp");
            owner.abort();
            return {behavior: "allow"};
        }}, {kind: "question", requestId: "question", toolName: "ask_user", delivery: "sync", message: "answer", input: {}},
        {cwd: "/tmp", ...identity, signal: owner.signal});
        expect(response.behavior).toBe("deny");
    }
});
