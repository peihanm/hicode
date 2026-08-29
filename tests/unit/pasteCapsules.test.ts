import {describe, expect, test} from "bun:test";
import {
    collapsePromptText,
    EMPTY_PASTE_CAPSULE_STATE,
    expandPasteCapsuleCursor,
    expandPasteCapsules,
    getPasteCapsuleRanges,
    insertPasteCapsule,
    removePasteCapsule,
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
