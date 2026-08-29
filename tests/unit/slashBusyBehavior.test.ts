import {describe, expect, test} from "bun:test";
import {slashCommandProcessor} from "../helpers/slash.js";

describe("Slash busy behavior", () => {
    test("只有无对话状态依赖的本地查看命令立即执行", () => {
        for (const input of [
            "/help",
            "/?",
            "/mode",
            "/mcp",
            "/sandbox",
            "/tasks",
        ]) {
            expect(slashCommandProcessor.getBusyBehavior(input)).toBe("immediate");
        }
    });

    test("会改变对话或打开交互界面的命令等待当前 Turn 结束", () => {
        for (const input of [
            "/compact",
            "/agents",
            "/memory",
            "/rewind",
            "/diff",
            "/commit",
            "/unknown",
        ]) {
            expect(slashCommandProcessor.getBusyBehavior(input)).toBe("defer");
        }
    });
});
