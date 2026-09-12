import {expect, test} from "bun:test";
import {writeFile} from "node:fs/promises";
import type {Todo} from "../../src/todos.js";
import type {Message} from "../../src/llm/types.js";
import {runAgentForTest} from "../helpers/agent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

test("Root 执行中提醒实时清单，真实 Todo 工具更新后停止提醒且不污染 History", async () => {
    await withTempProject(async cwd => {
        await writeFile(`${cwd}/fixture.txt`, "fixture");
        let todos: Todo[] = [];
        const initial: Todo[] = [
            {content: "项目骨架", activeForm: "搭建骨架", status: "in_progress"},
            {content: "核心逻辑", activeForm: "实现核心逻辑", status: "pending"},
        ];
        const next: Todo[] = [{...initial[0]!, status: "completed"}, {...initial[1]!, status: "in_progress"}];
        const fake = createFakeLLM([
            assistantToolCall("todo_write", {todos: initial}, "start"),
            ...Array.from({length: 10}, (_, i) => assistantToolCall("read_file", {path: "fixture.txt"}, `read-${i}`)),
            options => {
                expect(JSON.stringify(options.messages)).toContain("Todo progress check");
                expect(JSON.stringify(options.messages)).toContain("核心逻辑");
                const runtime = options.messages.filter(message => typeof message.content === "string" && message.content.includes("Todo progress check")).map(message => message.content).join("\n");
                expect(runtime.match(/核心逻辑/g)).toHaveLength(1);
                expect(todos).toEqual(initial);
                return assistantToolCall("todo_write", {todos: next}, "advance");
            },
            options => {
                expect(JSON.stringify(options.messages)).not.toContain("Todo progress check");
                expect(todos).toEqual(next);
                return assistantToolCall("todo_write", {todos: next.map(todo => ({...todo, status: "completed"}))}, "done");
            },
            assistantText("completed"),
        ]);
        const ctx = createTestContext(cwd, {setTodos: nextTodos => {todos = nextTodos;}});
        const history: Message[] = [{role: "system", content: "test"}];
        const result = await runAgentForTest("完成任务", history, () => {}, ctx, {callLLM: fake.callLLM, getTodos: () => todos});
        expect(result.reason).toBe("completed");
        expect(todos).toEqual([]);
        expect(fake.calls.slice(0, 11).some(call => JSON.stringify(call.messages).includes("Todo progress check"))).toBe(false);
        expect(JSON.stringify(history)).not.toContain("Todo progress check");
        const calls = history.flatMap(message => message.role === "assistant" ? message.tool_calls ?? [] : []);
        expect(history.filter(message => message.role === "tool")).toHaveLength(calls.length);
    });
});
