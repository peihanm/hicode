import {describe, expect, test} from "bun:test";
import {limitTerminalText} from "../../src/ui/conversation/presentationLimits.js";

describe("terminal presentation limits", () => {
    test("保留限制内的文本", () => {
        expect(limitTerminalText("hello", 5, "assistant output")).toBe("hello");
    });

    test("只截断终端投影并给出明确标记", () => {
        expect(limitTerminalText("abcdef", 4, "assistant output")).toBe(
            "abcd\n\n[assistant output truncated in terminal view]"
        );
    });
});
