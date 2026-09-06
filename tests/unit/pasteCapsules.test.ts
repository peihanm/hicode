import {describe, expect, test, spyOn} from "bun:test";
import {
    collapsePromptText,
    EMPTY_PASTE_CAPSULE_STATE,
    expandPasteCapsuleCursor,
    expandPasteCapsules,
    getPasteCapsuleRanges,
    insertPasteCapsule,
    removePasteCapsule,
    PasteInputBurst,
} from "../../src/ui/input/pasteCapsules.js";

describe("paste capsules", () => {
    test("短输入保持原文，长输入折叠后仍可无损展开", () => {
        const short = insertPasteCapsule(
            "before ",
            7,
            "short text",
            EMPTY_PASTE_CAPSULE_STATE
        );
        expect(short.collapsed).toBeFalse();
        expect(short.value).toBe("before short text");

        const content = "第一行\n第二行\n第三行\n第四行";
        const long = insertPasteCapsule(
            "before  after",
            7,
            content,
            EMPTY_PASTE_CAPSULE_STATE
        );
        expect(long.collapsed).toBeTrue();
        expect(long.value).toBe("before [Pasted text #1 +3 lines] after");
        expect(expandPasteCapsules(long.value, long.state)).toBe(
            `before ${content} after`
        );
    });

    test("多个 Capsule 使用稳定编号并正确换算真实光标", () => {
        const first = insertPasteCapsule(
            "",
            0,
            "a\nb\nc\nd",
            EMPTY_PASTE_CAPSULE_STATE
        );
        const second = insertPasteCapsule(
            `${first.value} tail `,
            first.value.length + 6,
            "x".repeat(801),
            first.state
        );

        expect(second.value).toContain("[Pasted text #1 +3 lines]");
        expect(second.value).toContain("[Pasted text #2]");
        expect(expandPasteCapsuleCursor(
            second.value,
            second.cursorOffset,
            second.state
        )).toBe("a\nb\nc\nd tail ".length + 801);
    });

    test("相邻的长粘贴分块合并为同一个 Capsule", () => {
        const burst = new PasteInputBurst();
        const firstContent = "一\n二\n三\n四\n";
        const secondContent = "五\n六\n七\n八";
        const first = burst.insert(
            "",
            0,
            firstContent,
            EMPTY_PASTE_CAPSULE_STATE
        );
        const second = burst.insert(
            first.value,
            first.cursorOffset,
            secondContent,
            first.state
        );

        expect(second.value).toBe("[Pasted text #1 +7 lines]");
        expect(second.value).not.toContain("#2");
        expect(second.state.capsules).toHaveLength(1);
        expect(second.state.nextId).toBe(2);
        expect(expandPasteCapsules(second.value, second.state)).toBe(
            firstContent + secondContent
        );
    });

    test("所有块均未达阈值、短尾块和跨块 CRLF 仍组成一个完整 Capsule", () => {
        const burst = new PasteInputBurst();
        const chunks = ["第一行\r", "\n第二行\n", "第三行\n", "第四行", "。"];
        let result = {value: "", cursorOffset: 0, state: EMPTY_PASTE_CAPSULE_STATE, collapsed: false};
        for (const chunk of chunks) result = burst.insert(result.value, result.cursorOffset, chunk, result.state);
        expect(result.value).toBe("[Pasted text #1 +3 lines]");
        expect(result.state.capsules).toHaveLength(1);
        expect(expandPasteCapsules(result.value, result.state)).toBe("第一行\n第二行\n第三行\n第四行。");
    });

    test("短间隔尾块合并，停顿后的补字和第二次粘贴独立保留", () => {
        let now = 0;
        const clock = spyOn(performance, "now").mockImplementation(() => now);
        try {
            const burst = new PasteInputBurst();
            const first = burst.insert("", 0, "一\n二\n三\n四", EMPTY_PASTE_CAPSULE_STATE);
            now = 5;
            const tail = burst.insert(first.value, first.cursorOffset, "尾巴", first.state);
            expect(tail.value).toBe(first.value);
            expect(tail.state.capsules[0]!.content).toEndWith("尾巴");
            now = 100;
            const suffix = burst.insert(tail.value, tail.cursorOffset, "补充", tail.state);
            expect(suffix.value).toBe(first.value + "补充");
            now = 200;
            const next = burst.insert(suffix.value, suffix.cursorOffset, "a\nb\nc\nd", suffix.state);
            expect(next.value).toContain("[Pasted text #2 +3 lines]");
            expect(expandPasteCapsules(next.value, next.state)).toBe("一\n二\n三\n四尾巴补充a\nb\nc\nd");
        } finally {clock.mockRestore();}
    });

    test("编辑边界结束 burst，即使光标回到同一位置也不再合并", () => {
        const burst = new PasteInputBurst();
        const first = burst.insert("", 0, "一\n二\n三\n四", EMPTY_PASTE_CAPSULE_STATE);
        burst.reset();
        const next = burst.insert(first.value, first.cursorOffset, "新文字", first.state);
        expect(next.value).toBe(first.value + "新文字");
    });

    test("删除 Capsule 后不会把已移除的内容带入提交文本", () => {
        const collapsed = collapsePromptText("one\ntwo\nthree\nfour");
        const [range] = getPasteCapsuleRanges(collapsed.value, collapsed.state);
        expect(range).toBeDefined();

        const value =
            collapsed.value.slice(0, range!.start) +
            collapsed.value.slice(range!.end);
        const state = removePasteCapsule(collapsed.state, range!.id);

        expect(expandPasteCapsules(value, state)).toBe("");
        expect(getPasteCapsuleRanges(value, state)).toEqual([]);
    });

    test("粘贴内容移除终端控制符并规范化换行和 Tab", () => {
        const collapsed = insertPasteCapsule(
            "",
            0,
            "\u001B[31mred\u001B[0m\r\n\tline 2\rline 3\nline 4",
            EMPTY_PASTE_CAPSULE_STATE
        );

        expect(expandPasteCapsules(collapsed.value, collapsed.state)).toBe(
            "red\n    line 2\nline 3\nline 4"
        );
    });
});
