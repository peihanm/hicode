import {describe, expect, test} from "bun:test";
import {slashCommandProcessor} from "../helpers/slash.js";
import {findSlashCommand} from "../../src/slash/registry.js";

describe("Slash busy behavior", () => {
    test("本地查看命令立即执行，包括只读面板和 Memory 子命令", () => {
        for (const input of [
            "/help",
            "/?",
            "/skills",
            "/tasks",
            "/hooks",
            "/diff",
            "/memory",
            "/memory status",
            "/memory list",
            "/memory list feedback",
            "/memory show coding-style",
            "  /memory   status  ",
        ]) {
            expect(slashCommandProcessor.getBusyBehavior(input)).toBe("immediate");
        }
    });

    test("修改会话或配置以及 Memory 维护等待当前 Turn 结束", () => {
        for (const input of [
            "/sandbox",
            "/mcp",
            "/mcp reconnect fixture",
            "/compact",
            "/permissions",
            "/agents",
            "/memory maintain",
            "/memory maintain extra",
            "/memory unknown",
            "/resume",
            "/model",
            "/providers",
            "/add-dir ../other",
            "/unknown",
        ]) {
            expect(slashCommandProcessor.getBusyBehavior(input)).toBe("defer");
        }
    });

    test("旧 /mode 权限别名不再注册", () => {
        expect(findSlashCommand("mode")).toBeUndefined();
    });
});
