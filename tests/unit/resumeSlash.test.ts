import {describe, expect, test} from "bun:test";
import {processSlashCommand} from "../helpers/slash.js";
import {createTestContext} from "../helpers/testContext.js";
import {withTempProject} from "../helpers/tempProject.js";

describe("/resume slash command", () => {
    test("只调用交互 Host 的会话恢复入口", async () => {
        await withTempProject(async (cwd) => {
            let opened = 0;
            expect(await processSlashCommand("/resume", {
                history: [],
                ctx: createTestContext(cwd),
                onEvent: () => {},
                openResume: () => {
                    opened += 1;
                },
            })).toBe(true);
            expect(opened).toBe(1);
        });
    });

    test("拒绝参数，并在没有交互 Host 时返回明确说明", async () => {
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
            expect(await processSlashCommand("/resume session-1", context)).toBe(true);
            expect(await processSlashCommand("/resume", context)).toBe(true);
            expect(messages).toEqual([
                "用法：/resume",
                "当前宿主不支持交互式 /resume。",
            ]);
        });
    });
});
