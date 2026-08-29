import {describe, expect, test} from "bun:test";
import {processSlashCommand} from "../helpers/slash.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("/commit slash command", () => {
    test("转换为受限的普通 Agent Prompt，并保留补充要求", async () => {
        await withTempProject(async (cwd) => {
            const result = await processSlashCommand(
                "/commit 除了 docs/ROADMAP.md",
                {
                    history: [],
                    ctx: createTestContext(cwd),
                    onEvent: () => {},
                }
            );
            expect(result).toMatchObject({kind: "prompt"});
            if (typeof result !== "object") return;
            expect(result.prompt).toContain("只使用 Bash");
            expect(result.prompt).toContain("git add -- <精确路径...>");
            expect(result.prompt).toContain("git status --short");
            expect(result.prompt).toContain("除了 docs/ROADMAP.md");
            expect(result.prompt).toContain("不得 Amend、Push");
            expect(result.allowedTools).toEqual([
                "bash",
                "read_tool_result",
            ]);
        });
    });
});
