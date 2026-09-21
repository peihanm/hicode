import {describe, expect, test} from "bun:test";
import {slashCommandProcessor} from "../helpers/slash.js";
import {findSlashCommand} from "../../src/slash/registry.js";

describe("Slash busy behavior", () => {
    test("只有无对话状态依赖的本地查看命令立即执行", () => {
        for (const input of [
            "/help",
            "/?",
            "/skills",
            "/tasks",
        ]) {
            expect(slashCommandProcessor.getBusyBehavior(input)).toBe("immediate");
        }
    });

    test("会改变对话或打开交互界面的命令等待当前 Turn 结束", () => {
        for (const input of [
            "/sandbox",
            "/mcp",
            "/mcp reconnect fixture",
            "/compact",
            "/permissions",
            "/agents",
            "/memory",
            "/diff",
            "/unknown",
        ]) {
            expect(slashCommandProcessor.getBusyBehavior(input)).toBe("defer");
        }
    });

    test("旧 /mode 权限别名不再注册", () => {
        expect(findSlashCommand("mode")).toBeUndefined();
    });
});
