import {describe, expect, test} from "bun:test";
import {render} from "ink-testing-library";
import {TodoList} from "../../src/ui/status/TodoList.js";
import type {Todo} from "../../src/todos.js";
import {createTestContext} from "../helpers/testContext.js";
import {executeToolResult} from "../helpers/executeTool.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("TodoList", () => {
    test("真实 Todo 工具推进阶段后显示完成项和下一进行项，全部完成清空", async () => {
        await withTempProject(async cwd => {
            const initial: Todo[] = [
                {content: "项目骨架", activeForm: "搭建骨架", status: "in_progress"},
                {content: "核心逻辑", activeForm: "实现核心逻辑", status: "pending"},
            ];
            const instance = render(<TodoList todos={initial}/>);
            try {
                const ctx = createTestContext(cwd, {setTodos: todos => {instance.rerender(<TodoList todos={todos}/>);}});
                const next = [{...initial[0]!, status: "completed"}, {...initial[1]!, status: "in_progress"}];
                const result = await executeToolResult("todo_write", JSON.stringify({todos: next}), ctx, "advance");
                expect(result.outcome).toBe("ok");
                await new Promise(resolve => setTimeout(resolve, 0));
                expect(instance.lastFrame()).toContain("✓ 项目骨架");
                expect(instance.lastFrame()).toContain("实现核心逻辑");
                expect(instance.lastFrame()).not.toContain("搭建骨架");
                await executeToolResult("todo_write", JSON.stringify({todos: next.map(todo => ({...todo, status: "completed"}))}), ctx, "done");
                await new Promise(resolve => setTimeout(resolve, 0));
                expect(instance.lastFrame()?.trim()).toBe("");
            } finally {
                instance.unmount();
            }
        });
    });

    test("列表从有内容变为空时保持稳定的 Hook 生命周期", () => {
        const instance = render(
            <TodoList todos={[{
                content: "检查实现",
                activeForm: "正在检查实现",
                status: "in_progress",
            }]}/>
        );
        expect(instance.lastFrame()).toContain("正在检查实现");

        instance.rerender(<TodoList todos={[]}/>);
        expect(instance.lastFrame()?.trim()).toBe("");
        instance.unmount();
    });
});
