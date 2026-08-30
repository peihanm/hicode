import {describe, expect, test} from "bun:test";
import {render} from "ink-testing-library";
import {TodoList} from "../../src/ui/status/TodoList.js";

describe("TodoList", () => {
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
