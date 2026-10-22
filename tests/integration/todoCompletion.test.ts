import {expect, test} from "bun:test";
import type {AgentEvent} from "../../src/agent/types.js";
import type {Message} from "../../src/llm/types.js";
import type {Todo} from "../../src/session/todo.js";
import {runAgentForTest} from "../helpers/agent.js";
import {assistantText, assistantToolCall, createFakeLLM} from "../helpers/fakeLLM.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

const item: Todo = {content: "完成验证", activeForm: "正在验证", status: "in_progress"};

test("连续三次声称完成仍被拦截，实际清空 Todo 后才发布最终回答", async () => {
    await withTempProject(async cwd => {
        let todos: Todo[] = [];
        const history: Message[] = [{role: "system", content: "test system prompt"}];
        const events: AgentEvent[] = [];
        const fake = createFakeLLM([
            assistantToolCall("todo_write", {todos: [item]}, "plan"),
            assistantText("完成声明一"),
            options => {
                expect(JSON.stringify(options.messages)).toContain("still has unfinished todos");
                expect(todos).toEqual([item]);
                return assistantText("完成声明二");
            },
            options => {
                expect(JSON.stringify(options.messages)).toContain("完成声明二");
                expect(todos).toEqual([item]);
                return assistantText("完成声明三");
            },
            options => {
                expect(JSON.stringify(options.messages)).toContain("still has unfinished todos");
                expect(JSON.stringify(options.messages)).toContain("完成声明三");
                expect(todos).toEqual([item]);
                return assistantToolCall("todo_write", {todos: [{...item, status: "completed"}]}, "done");
            },
            options => {
                expect(JSON.stringify(options.messages)).not.toContain("still has unfinished todos");
                return assistantText("验证完成");
            },
        ]);
        const result = await runAgentForTest("完成任务", history, event => {events.push(event);},
            createTestContext(cwd, {setTodos: next => {todos = next;}}),
            {callLLM: fake.callLLM, getTodos: () => todos});
        expect(result.reason).toBe("completed");
        expect(result.iterations).toBe(6);
        expect(todos).toEqual([]);
        expect(events.filter(event => event.type === "assistant_text").map(event => event.content)).toEqual(["验证完成"]);
        expect(history.filter(message => message.role === "assistant" && !message.tool_calls).map(message => message.content)).toEqual(["验证完成"]);
        expect(JSON.stringify(history)).not.toContain("still has unfinished todos");
    });
});

test("仅剩 pending 也不能结束，从进行中改回 pending 仍须处理", async () => {
    await withTempProject(async cwd => {
        let todos: Todo[] = [item];
        const fake = createFakeLLM([
            assistantText("完成了"),
            assistantToolCall("todo_write", {todos: [{...item, status: "pending"}]}, "defer"),
            assistantText("留待以后处理，先结束"),
            options => {
                expect(JSON.stringify(options.messages)).toContain("[pending] 完成验证");
                expect(todos[0]?.status).toBe("pending");
                return assistantToolCall("todo_write", {todos: [{...item, status: "completed"}]}, "done");
            },
            assistantText("实际完成验证"),
        ]);
        const result = await runAgentForTest("完成任务", [{role: "system", content: "test system prompt"}], () => {},
            createTestContext(cwd, {setTodos: next => {todos = next;}}),
            {callLLM: fake.callLLM, getTodos: () => todos});
        expect(result.reason).toBe("completed");
        expect(fake.calls).toHaveLength(5);
        expect(todos).toEqual([]);
    });
});

test("最后一次迭代仍有待办时按预算中止，不能接受完成声明", async () => {
    await withTempProject(async cwd => {
        const todos: Todo[] = [{...item, status: "pending"}];
        const events: AgentEvent[] = [];
        const history: Message[] = [{role: "system", content: "test system prompt"}];
        const fake = createFakeLLM([assistantText("第一次声称完成"), assistantText("预算用尽时声称完成")]);
        const result = await runAgentForTest("完成任务", history, event => {events.push(event);}, createTestContext(cwd),
            {callLLM: fake.callLLM, getTodos: () => todos, maxIterations: 2});
        expect(result.reason).toBe("max_turns");
        expect(result.iterations).toBe(2);
        expect(todos[0]?.status).toBe("pending");
        expect(history.some(message => message.role === "assistant")).toBe(false);
        expect(events.filter(event => event.type === "assistant_text").map(event => event.content)).toEqual([result.reply]);
        expect(result.reply).not.toContain("声称完成");
    });
});

test("重复拦截期间仍可取消，取消不清空未完成 Todo", async () => {
    await withTempProject(async cwd => {
        const controller = new AbortController();
        const todos = [item];
        const fake = createFakeLLM([
            assistantText("完成声明"),
            options => {
                expect(JSON.stringify(options.messages)).toContain("still has unfinished todos");
                controller.abort("user-cancel");
                return assistantText("不能接受这次回复");
            },
        ]);
        const result = await runAgentForTest("完成任务", [{role: "system", content: "test system prompt"}], () => {}, createTestContext(cwd, {signal: controller.signal}),
            {callLLM: fake.callLLM, getTodos: () => todos});
        expect(result.reason).toBe("interrupted");
        expect(todos).toEqual([item]);
        expect(fake.calls).toHaveLength(2);
    });
});

test("被拦截后仍消费用户新指令，明确取消的范围可从 Todo 移除", async () => {
    await withTempProject(async cwd => {
        let todos: Todo[] = [{...item, status: "pending"}];
        let deliver = false;
        const history: Message[] = [{role: "system", content: "test system prompt"}];
        const fake = createFakeLLM([
            () => {deliver = true; return assistantText("准备结束");},
            options => {
                expect(options.messages.some(message => message.role === "user" && message.content === "取消剩余验证" )).toBe(true);
                return assistantToolCall("todo_write", {todos: []}, "cancel-scope");
            },
            assistantText("已按要求取消剩余验证"),
        ]);
        const result = await runAgentForTest("完成任务", history, () => {},
            createTestContext(cwd, {setTodos: next => {todos = next;}}), {
                callLLM: fake.callLLM, getTodos: () => todos,
                inputChannel: {
                    drainInitial: () => [],
                    drainSafeBoundary: () => {
                        if (!deliver) return [];
                        deliver = false;
                        return [{id: "steer", source: "user_input", content: "取消剩余验证"}];
                    },
                    waitForInput: async () => {},
                },
            });
        expect(result.reason).toBe("completed");
        expect(result.reply).toBe("已按要求取消剩余验证");
        expect(todos).toEqual([]);
    });
});
