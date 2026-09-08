import {contentText} from "../../src/images/content.js";
import {describe, expect, test} from "bun:test";
import {buildForkContextSnapshot, createForkResultFiles} from "../../src/subagents/fork.js";
import type {Message} from "../../src/llm/types.js";
import {withTempProject} from "../helpers/tempProject.js";
import {createTestToolResultStore} from "../helpers/toolResultStore.js";

describe("fork context snapshot", () => {
    test("父文件集合固定，Task/Read 引用可读，未引用结果保持隔离", async () => {
        await withTempProject(async cwd => {
            const parent = createTestToolResultStore(cwd, "parent");
            const local = createTestToolResultStore(cwd, "child");
            const results = await Promise.all(["task", "diff", "page", "hidden"].map(id =>
                parent.persistText({toolCallId: id, toolName: "test", content: `parent ${id}`})));
            const [task, diff, page, hidden] = results;
            const history: Message[] = [
                {role: "assistant", content: null, tool_calls: ["task", "read_file"].map(name => ({
                    id: name, type: "function", function: {name, arguments: "{}"},
                }))},
                {role: "tool", tool_call_id: "task", content: `Saved output: ${JSON.stringify(task!.path)}\nSaved diff: ${JSON.stringify(diff!.path)}`},
                {role: "tool", tool_call_id: "read_file", content: `Saved output: ${JSON.stringify(page!.path)}\nComplete artifact: yes`},
                {role: "user", content: `Saved output: ${JSON.stringify(hidden!.path)}`},
            ];
            const files = createForkResultFiles(history, parent, local);
            history.push({role: "tool", tool_call_id: "task", content: `Saved output: ${JSON.stringify(hidden!.path)}`});
            for (const result of results.slice(0, 3)) expect((await files.resolveFile(result.path))?.path).toBe(result.path);
            await expect(files.resolveFile(hidden!.path)).rejects.toThrow("无权");
            const child = await local.persistText({toolCallId: "child", toolName: "test", content: "child"});
            expect((await files.resolveFile(child.path))?.path).toBe(child.path);
            await expect(parent.resolveFile(child.path)).rejects.toThrow("无权");
            expect(Object.keys(files)).toEqual(["resolveFile"]);
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
            message.role === "tool" && contentText(message.content).includes("父线程继续处理")
        )).toBe(true);
        expect(history).toHaveLength(3);
    });
});
