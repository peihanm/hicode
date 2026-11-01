import {describe, expect, test} from "bun:test";
import {processSlashCommand} from "../helpers/slash.js";
import {withTempProject} from "../helpers/tempProject.js";
import type {SandboxStatus} from "../../src/sandbox/index.js";
import {getSlashCommandSuggestions} from "../../src/slash/registry.js";
import {createTestContext} from "../helpers/testContext.js";

describe("/sandbox", () => {
    test.each([
        {status: {kind: "ready", networkMode: "restricted", platform: "macos", warnings: []}, expected: "Platform: macos"},
        {status: {kind: "unavailable", reason: "socket denied", warnings: ["nested sandbox"]}, expected: "socket denied"},
    ] satisfies {status: SandboxStatus; expected: string}[])("reports runner status: $expected", async ({status, expected}) => {
        await withTempProject(async cwd => {
            const output: string[] = [];
            await processSlashCommand("/sandbox", {
                history: [],
                ctx: createTestContext(cwd, {shellRunner: {
                    sandboxStatus: status,
                    async run() {throw new Error("Status queries must not execute commands");},
                }}),
                onEvent(event) {if (event.type === "assistant_text") output.push(event.content);},
            });
            expect(output.join("\n")).toContain(expected);
            for (const warning of status.warnings) expect(output.join("\n")).toContain(warning);
        });
    });

    test("注册到 slash suggestions 并读取当前 Runner 状态", async () => {
        expect(getSlashCommandSuggestions("/sand")).toEqual([
            {
                name: "sandbox",
                description: "Show Bash OS Sandbox status",
                argumentHint: undefined,
            },
        ]);
        const events: string[] = [];
        await processSlashCommand("/sandbox", {
            history: [],
            ctx: createTestContext("/tmp/project"),
            onEvent(event) {
                if (event.type === "assistant_text") events.push(event.content);
            },
        });
        expect(events).toEqual([
            expect.stringContaining("Bash Sandbox: ready"),
        ]);
    });
});
