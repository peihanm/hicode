import {afterEach, describe, expect, test} from "bun:test";
import {cleanup, render} from "ink-testing-library";
import {useState} from "react";
import {
    MultilineTextInput,
    type InputAtomicRange,
} from "../../src/ui/input/MultilineTextInput.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function press(instance: {stdin: {write: (data: string) => void}}, key: string) {
    instance.stdin.write(key);
    await tick();
}

function renderInput(
    initial: string,
    options: {
        atomicRanges?: readonly InputAtomicRange[];
        onAtomicRangeDelete?: (range: InputAtomicRange) => void;
    } = {}
) {
    const state = {value: initial, cursor: initial.length};
    function Harness() {
        const [value, setValue] = useState(initial);
        return (
            <MultilineTextInput
                value={value}
                onChange={setValue}
                onSubmit={() => {}}
                width={40}
                atomicRanges={options.atomicRanges}
                onAtomicRangeDelete={options.onAtomicRangeDelete}
                onEditStateChange={(next) => {
                    state.value = next.value;
                    state.cursor = next.cursorOffset;
                }}
            />
        );
    }
    return {instance: render(<Harness/>), state};
}

describe("输入框 readline 风格快捷键", () => {
    afterEach(() => cleanup());

    test("Ctrl+U 删除光标到行首", async () => {
        const {instance, state} = renderInput("hello world");
        await tick();
        for (let index = 0; index < 5; index++) await press(instance, "\u001b[D");
        expect(state.cursor).toBe(6);

        await press(instance, "\u0015");
        expect(state.value).toBe("world");
        expect(state.cursor).toBe(0);
    });

    test("Ctrl+U 只删除光标所在行", async () => {
        const {instance, state} = renderInput("one\ntwo");
        await tick();
        expect(state.cursor).toBe(7);

        await press(instance, "\u0015");
        expect(state.value).toBe("one\n");
        expect(state.cursor).toBe(4);
    });

    test("Ctrl+K 删除光标到行尾并保留换行符", async () => {
        const {instance, state} = renderInput("hello world");
        await tick();
        for (let index = 0; index < 8; index++) await press(instance, "\u001b[D");
        expect(state.cursor).toBe(3);

        await press(instance, "\u000b");
        expect(state.value).toBe("hel");
        expect(state.cursor).toBe(3);

        const multiline = renderInput("one\ntwo");
        await tick();
        await press(multiline.instance, "\u001b[D");
        await press(multiline.instance, "\u001b[D");
        await press(multiline.instance, "\u001b[D");
        await press(multiline.instance, "\u001b[D");
        await press(multiline.instance, "\u001b[D");
        expect(multiline.state.cursor).toBe(2);

        await press(multiline.instance, "\u000b");
        expect(multiline.state.value).toBe("on\ntwo");
        expect(multiline.state.cursor).toBe(2);
    });

    test("Ctrl+W 删除前一个空白分隔的单词", async () => {
        const {instance, state} = renderInput("hello world  ");
        await tick();

        await press(instance, "\u0017");
        expect(state.value).toBe("hello ");
        expect(state.cursor).toBe(6);

        const cjk = renderInput("你好 世界");
        await tick();
        await press(cjk.instance, "\u0017");
        expect(cjk.state.value).toBe("你好 ");
        expect(cjk.state.cursor).toBe(3);
    });

    test("Ctrl+A / Ctrl+E 在行首与行尾之间移动光标", async () => {
        const {instance, state} = renderInput("one\ntwo");
        await tick();
        expect(state.cursor).toBe(7);

        await press(instance, "\u0001");
        expect(state.cursor).toBe(4);

        await press(instance, "X");
        expect(state.value).toBe("one\nXtwo");
        expect(state.cursor).toBe(5);

        await press(instance, "\u0005");
        expect(state.cursor).toBe(8);

        await press(instance, "!");
        expect(state.value).toBe("one\nXtwo!");
        expect(state.cursor).toBe(9);
    });

    test("Ctrl+U 整体删除粘贴胶囊并通知调用方", async () => {
        const value = "[Pasted text #1]";
        const removed: InputAtomicRange[] = [];
        const {instance, state} = renderInput(value, {
            atomicRanges: [{id: 1, start: 0, end: value.length}],
            onAtomicRangeDelete: (range) => removed.push(range),
        });
        await tick();

        await press(instance, "\u0015");
        expect(state.value).toBe("");
        expect(state.cursor).toBe(0);
        expect(removed).toEqual([{id: 1, start: 0, end: value.length}]);
    });
});
