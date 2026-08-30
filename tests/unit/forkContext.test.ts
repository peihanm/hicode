import {describe, expect, test} from "bun:test";
import {buildForkContextSnapshot} from "../../src/subagents/fork.js";
import type {Message} from "../../src/llm/types.js";

describe("fork context snapshot", () => {
    test("继承父前缀并为同批全部 tool call 补齐稳定占位", () => {
        const history: Message[] = [
            {role: "system", content: "root system"},
            {role: "user", content: "实现 web 应用"},
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "fork-frontend",
                        type: "function",
                        function: {name: "agent", arguments: "{}"},
                    },
                    {
                        id: "fork-backend",
                        type: "function",
                        function: {name: "agent", arguments: "{}"},
                    },
                ],
            },
        ];
        const snapshot = buildForkContextSnapshot(history, "fork-frontend");
        expect(snapshot.history).toHaveLength(5);
        const results = snapshot.history.filter((message) => message.role === "tool");
        expect(results.map((message) =>
            message.role === "tool" ? message.tool_call_id : ""
        )).toEqual(["fork-frontend", "fork-backend"]);
        expect(results.every((message) =>
            message.role === "tool" && message.content.includes("父线程继续处理")
        )).toBe(true);
        expect(history).toHaveLength(3);
    });
});
