import {describe, expect, test} from "bun:test";
import {applyCommandToolPolicy} from "../../src/slash/toolPolicy.js";
import type {ToolContext} from "../../src/tools/types.js";

function schema(name: string) {
    return {
        type: "function" as const,
        function: {name, description: name, parameters: {type: "object"}},
    };
}

describe("Prompt Slash Tool Policy", () => {
    test("同时收窄 Schema、执行和并发判断", async () => {
        const executed: string[] = [];
        const tools = applyCommandToolPolicy({
            getToolSchemas: () => [
                schema("read_file"),
                schema("edit_file"),
                schema("bash"),
                schema("task"),
                schema("agent"),
            ],
            executeTool: async (name) => {
                executed.push(name);
                return {
                    modelContent: `ran ${name}`,
                    displayContent: `ran ${name}`,
                    outcome: "ok",
                };
            },
            isToolConcurrencySafe: () => true,
        }, ["read_file"]);

        expect(tools.getToolSchemas().map((item) => item.function.name))
            .toEqual(["read_file"]);
        expect(tools.isToolConcurrencySafe("read_file", "{}")).toBe(true);
        expect(tools.isToolConcurrencySafe("edit_file", "{}")).toBe(false);
        for (const name of ["edit_file", "bash", "task", "agent"]) {
            const denied = await tools.executeTool(
                name,
                "{}",
                {} as ToolContext,
                `call-denied-${name}`
            );
            expect(typeof denied === "string" ? denied : denied.outcome)
                .toBe("denied");
        }
        expect(executed).toEqual([]);
        await tools.executeTool(
            "read_file",
            "{}",
            {} as ToolContext,
            "call-read"
        );
        expect(executed).toEqual(["read_file"]);
    });

    test("未知或重复工具名在 Agent 启动前失败", () => {
        const tools = {
            getToolSchemas: () => [schema("read_file")],
            executeTool: async () => "ok",
            isToolConcurrencySafe: () => false,
        };
        expect(() => applyCommandToolPolicy(tools, ["missing"]))
            .toThrow("当前 Runtime 不可用");
        expect(() => applyCommandToolPolicy(tools, ["read_file", "read_file"]))
            .toThrow("重复工具名");
    });
});
