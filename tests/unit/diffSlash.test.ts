import {describe, expect, test} from "bun:test";
import {processSlashCommand} from "../helpers/slash.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("/diff slash command", () => {
    test("无参数打开交互式 Diff", async () => {
        await withTempProject(async (cwd) => {
            let opened = 0;
            const context = {
                history: [],
                ctx: createTestContext(cwd),
                onEvent: () => {},
                openGitDiff: () => opened += 1,
            };
            expect(await processSlashCommand("/diff", context)).toBe(true);
            expect(opened).toBe(1);
        });
    });

    test("非法参数和非交互 Host 返回明确说明", async () => {
        await withTempProject(async (cwd) => {
            const messages: string[] = [];
            const context = {
                history: [],
                ctx: createTestContext(cwd),
                onEvent(event: {type: string; content?: string}) {
                    if (event.type === "assistant_text" && event.content) {
                        messages.push(event.content);
                    }
                },
            };
            await processSlashCommand("/diff invalid", context);
            await processSlashCommand("/diff", context);
            expect(messages).toEqual([
                "用法: /diff",
                "当前宿主不支持交互式 /diff。请在交互式 TUI 中使用，或通过 Bash 运行只读的 git diff。",
            ]);
        });
    });
});
