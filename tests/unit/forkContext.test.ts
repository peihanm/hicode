import {describe, expect, test} from "bun:test";
import {buildForkContextSnapshot, createForkResultReader} from "../../src/subagents/fork.js";
import type {Message} from "../../src/llm/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";

describe("fork context snapshot", () => {
    test("父读取集合固定，Task/分页引用可读，子结果和未引用结果保持隔离", async () => {
        await withTempProject(async cwd => {
            const parent = createTestToolResultStore(cwd, "parent");
            const local = createTestToolResultStore(cwd, "child");
            const ids = ["task", "diff", "page", "hidden"];
            for (const id of ids) await parent.persistText({toolCallId: id, toolName: "test", resultId: id, content: `parent ${id}`});
            const history: Message[] = [
                {role: "assistant", content: null, tool_calls: ["task", "read_tool_result"].map(name => ({
                    id: name, type: "function", function: {name, arguments: "{}"},
                }))},
                {role: "tool", tool_call_id: "task", content: "Result ID: task\nDiff Result ID: diff"},
                {role: "tool", tool_call_id: "read_tool_result", content: "Result: page\nBytes: 0-2 / 20"},
                {role: "user", content: "Result ID: hidden"},
            ];
            const reader = createForkResultReader(history, parent, local);
            history.push({role: "tool", tool_call_id: "task", content: "Result ID: hidden"});
            for (const id of ids.slice(0, 3)) expect((await reader.readRange({resultId: id, offset: 0, limit: 100})).content).toBe(`parent ${id}`);
            await expect(reader.readRange({resultId: "hidden", offset: 0, limit: 100})).rejects.toThrow("not found");
            const childResult = await local.persistText({toolCallId: "child-only", toolName: "test", content: "child"});
            expect((await reader.readRange({resultId: childResult.resultId, offset: 0, limit: 100})).content).toBe("child");
            await expect(parent.readRange({resultId: childResult.resultId, offset: 0, limit: 100})).rejects.toThrow("not found");
            expect(Object.keys(reader)).toEqual(["readRange"]);
        });
    });

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
