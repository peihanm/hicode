import {expect, test} from "bun:test";
import {ContextUsageTracker} from "../../src/context/usage.js";
import {tokenCountWithEstimation} from "../../src/context/tokens.js";
import type {Message, OpenAITool} from "../../src/llm/types.js";

const scope = {model: "glm-test", provider: "glm" as const, compactCount: 0};
const messages: Message[] = [{role: "system", content: "system"}, {role: "user", origin: "user", content: "x".repeat(1000)}];

test.each([100, 7900])("实报 %i 校准低估/高估，未知 usage 保持有依据的增量估算", input => {
    const tracker = new ContextUsageTracker();
    tracker.record(scope, messages, [], input, 10000);
    const next: Message[] = [...messages, {role: "assistant", content: "新增内容"}];
    tracker.record(scope, next, [], undefined);
    expect(tracker.estimate(scope, next, [])).toBe(input + tokenCountWithEstimation(next, []) - tokenCountWithEstimation(messages, []));
    expect(tracker.contextWindow(scope)).toBe(10000);
});

test("模型/压缩/工具变化重建基线；其他 Session 不继承它", () => {
    const tool: OpenAITool = {type: "function", function: {name: "fixture", description: "new", parameters: {type: "object"}}};
    for (const changed of [{...scope, model: "other"}, {...scope, provider: "qwen" as const}, {...scope, compactCount: 1}]) {
        const tracker = new ContextUsageTracker(); tracker.record(scope, messages, [], 7900);
        expect(tracker.estimate(changed, messages, [])).toBe(tokenCountWithEstimation(messages, []));
    }
    const tracker = new ContextUsageTracker(); tracker.record(scope, messages, [], 7900);
    expect(tracker.estimate(scope, messages, [tool])).toBe(tokenCountWithEstimation(messages, [tool]));
    expect(new ContextUsageTracker().estimate(scope, messages, [])).toBe(tokenCountWithEstimation(messages, []));
    tracker.reset(); expect(tracker.contextWindow(scope)).toBeUndefined();
});
