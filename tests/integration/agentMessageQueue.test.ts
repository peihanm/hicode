import {describe, expect, test} from "bun:test";
import type {Message} from "../../src/llm/types.js";
import {RuntimeMessageQueue} from "../../src/runtime/messageQueue.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {runAgentForTest} from "../helpers/agent.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("Agent running input queue", () => {
    test("工具结果完整配对后才注入 next 消息", async () => {
        await withTempProject(async (cwd) => {
            const queue = new RuntimeMessageQueue();
            const history: Message[] = [{role: "system", content: "system"}];
            const fake = createFakeLLM([
                assistantToolCall("fixture", {}, "tool-1"),
                (options) => {
                    const roles = options.messages.map((message) => message.role);
                    expect(roles.slice(-3)).toEqual([
                        "assistant",
                        "tool",
                        "user",
                    ]);
                    expect(options.messages.at(-1)?.content).toBe("补充要求");
                    return assistantText("已按补充要求完成");
                },
            ]);

            const result = await runAgentForTest(
                "原始任务",
                history,
                () => {},
                createTestContext(cwd),
                {
                    callLLM: fake.callLLM,
                    getToolSchemas: () => [{type: "function", function: {
                        name: "fixture", description: "Test input delivery", parameters: {type: "object", properties: {}},
                    }}],
                    executeTool: async () => {
                        queue.enqueueUser("补充要求", "next");
                        return "tool ok";
                    },
                    inputChannel: queue.createAgentInputChannel(() => {}),
                }
            );

            expect(result.reply).toBe("已按补充要求完成");
            expect(queue.list()).toHaveLength(0);
        });
    });
});
