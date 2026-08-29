import {describe, expect, test} from "bun:test";
import {formatSandboxStatus, sandboxCommand} from "../../src/slash/commands/sandbox.js";
import {getSlashCommandSuggestions} from "../../src/slash/registry.js";
import {createTestContext} from "../helpers/testContext.js";

describe("/sandbox", () => {
    test("格式化 disabled、ready 和 unavailable 状态", () => {
        expect(formatSandboxStatus({kind: "disabled"})).toContain("disabled");
        expect(formatSandboxStatus({
            kind: "ready",
            platform: "macos",
            warnings: [],
        })).toContain("Platform: macos");
        expect(formatSandboxStatus({
            kind: "unavailable",
            reason: "socket denied",
            warnings: ["nested sandbox"],
        })).toContain("socket denied");
    });

    test("注册到 slash suggestions 并读取当前 Runner 状态", async () => {
        expect(getSlashCommandSuggestions("/sand")).toEqual([
            {
                name: "sandbox",
                description: "显示 Bash OS Sandbox 状态",
                argumentHint: undefined,
            },
        ]);
        const events: string[] = [];
        await sandboxCommand.execute("", {
            history: [],
            ctx: createTestContext("/tmp/project"),
            onEvent(event) {
                if (event.type === "assistant_text") events.push(event.content);
            },
            compactHistory: async () => ({
                history: [],
                compacted: false,
                preTokenCount: 0,
                threshold: 0,
            }),
            getToolSchemas: () => [],
            subagents: {
                issues: [],
                has: () => false,
                get: () => undefined,
                listDefinitions: () => [],
            },
        });
        expect(events).toEqual([
            expect.stringContaining("Bash Sandbox: disabled"),
        ]);
    });
});
